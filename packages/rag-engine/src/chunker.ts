import { createHash } from 'node:crypto';
import {
  ChunkKind,
  DEFAULT_CHUNK_MAX_TOKENS,
  detectLanguage,
  estimateTokens,
  guessTestPaths,
  type ChunkMetadata,
  type CodeChunk,
} from '@codelens/shared';

/**
 * Repository chunking.
 *
 * The central decision here is that chunks follow *semantic* boundaries, not
 * character counts. A retrieval system that splits a function in half destroys
 * the thing that made the chunk worth retrieving: the model receives a fragment
 * with no signature, no return statement, and no way to judge correctness.
 *
 * So each chunk is a whole declaration where possible — a function, class,
 * method, route handler, schema model, test case, or documentation section — and
 * carries the structural metadata (imports, exports, linked test path) that
 * powers the non-vector retrieval strategies.
 *
 * Boundary detection is brace- and indentation-based rather than a real parser.
 * Same tradeoff as the complexity estimator: correct enough for retrieval, and
 * it avoids a native Tree-sitter build on every deployment target. Tree-sitter
 * is the planned upgrade and this module's interface is what it would satisfy.
 */

export interface ChunkerOptions {
  maxTokens: number;
  /** Symbols below this size are merged with neighbours to avoid chunk spam. */
  minTokens: number;
  /** Paths present in the repository, used to resolve linked test files. */
  knownPaths: ReadonlySet<string>;
}

export const DEFAULT_CHUNKER_OPTIONS: Omit<ChunkerOptions, 'knownPaths'> = {
  maxTokens: DEFAULT_CHUNK_MAX_TOKENS,
  minTokens: 25,
};

export function chunkFile(params: {
  repositoryId: string;
  path: string;
  content: string;
  options?: Partial<ChunkerOptions>;
}): CodeChunk[] {
  const { repositoryId, path, content } = params;
  const options: ChunkerOptions = {
    ...DEFAULT_CHUNKER_OPTIONS,
    knownPaths: new Set(),
    ...params.options,
  };

  if (!content.trim()) return [];

  const language = detectLanguage(path);

  // Markdown is structured by headings, which are far better chunk boundaries
  // than anything a code-oriented splitter would find.
  if (language === 'markdown') {
    return chunkMarkdown({ repositoryId, path, content, language, options });
  }

  if (language === 'prisma') {
    return chunkPrismaSchema({ repositoryId, path, content, language, options });
  }

  if (language === 'sql') {
    return chunkSql({ repositoryId, path, content, language, options });
  }

  if (language === 'json' || language === 'yaml' || language === 'toml') {
    // Config is only useful as a whole; splitting it produces context-free
    // fragments like a bare version number.
    return [
      buildChunk({
        repositoryId,
        path,
        symbol: null,
        kind: ChunkKind.CONFIG_BLOCK,
        language,
        content: truncateToTokens(content, options.maxTokens),
        startLine: 1,
        endLine: content.split('\n').length,
        metadata: emptyMetadata(),
      }),
    ];
  }

  return chunkSourceCode({ repositoryId, path, content, language, options });
}

// ---------------------------------------------------------------- source code

interface ChunkContext {
  repositoryId: string;
  path: string;
  content: string;
  language: string;
  options: ChunkerOptions;
}

/** Declaration patterns, ordered so more specific forms win. */
const DECLARATION_PATTERNS: ReadonlyArray<{ kind: ChunkKind; pattern: RegExp }> = [
  { kind: ChunkKind.CLASS, pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: ChunkKind.INTERFACE, pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: ChunkKind.INTERFACE, pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: ChunkKind.FUNCTION, pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: ChunkKind.FUNCTION, pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
  { kind: ChunkKind.FUNCTION, pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  { kind: ChunkKind.CLASS, pattern: /^\s*class\s+([A-Za-z_][\w]*)/ },
  { kind: ChunkKind.FUNCTION, pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/ },
  { kind: ChunkKind.FUNCTION, pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
];

/** Test-framework blocks, chunked so the AI can mirror existing test style. */
const TEST_PATTERNS: readonly RegExp[] = [
  /^\s*(?:it|test)\s*(?:\.\w+)?\s*\(\s*['"`](.+?)['"`]/,
  /^\s*describe\s*(?:\.\w+)?\s*\(\s*['"`](.+?)['"`]/,
  /^\s*def\s+(test_[\w]+)/,
];

/** Route registrations, enriched with method and path. */
const ROUTE_PATTERNS: readonly RegExp[] = [
  /@(Get|Post|Put|Patch|Delete|All)\s*\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/,
  /(?:router|app)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/,
  /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/,
];

function chunkSourceCode(ctx: ChunkContext): CodeChunk[] {
  const { content, options } = ctx;
  const lines = content.split('\n');

  const fileImports = extractImports(content);
  const fileExports = extractExports(content);
  const linkedTestPath = resolveLinkedTest(ctx.path, options.knownPaths);

  const boundaries = findDeclarationBoundaries(lines, ctx.language);
  const chunks: CodeChunk[] = [];

  // Nothing recognizable: fall back to a sliding window over the whole file so
  // the content is still retrievable, just less precisely.
  if (boundaries.length === 0) {
    return windowChunks(ctx, fileImports, fileExports, linkedTestPath);
  }

  for (const boundary of boundaries) {
    const body = lines.slice(boundary.startLine - 1, boundary.endLine).join('\n');
    const tokens = estimateTokens(body);

    if (tokens < options.minTokens) continue;

    const metadata: ChunkMetadata = {
      imports: fileImports,
      exports: fileExports,
      route: boundary.route,
      linkedTestPath,
      parentSymbol: boundary.parentSymbol,
      docComment: extractDocComment(lines, boundary.startLine),
      isPartial: false,
      partIndex: null,
    };

    // An oversized symbol is split, but every part repeats the signature line so
    // each fragment remains interpretable on its own.
    if (tokens > options.maxTokens) {
      const signature = lines[boundary.startLine - 1] ?? '';
      const parts = splitOversized(body, options.maxTokens, signature);

      for (const [index, part] of parts.entries()) {
        chunks.push(
          buildChunk({
            repositoryId: ctx.repositoryId,
            path: ctx.path,
            symbol: boundary.symbol,
            kind: boundary.kind,
            language: ctx.language,
            content: part,
            startLine: boundary.startLine,
            endLine: boundary.endLine,
            metadata: { ...metadata, isPartial: true, partIndex: index },
          }),
        );
      }
      continue;
    }

    chunks.push(
      buildChunk({
        repositoryId: ctx.repositoryId,
        path: ctx.path,
        symbol: boundary.symbol,
        kind: boundary.kind,
        language: ctx.language,
        content: body,
        startLine: boundary.startLine,
        endLine: boundary.endLine,
        metadata,
      }),
    );
  }

  // A file-level chunk is added alongside symbol chunks so queries about the
  // file as a whole ("what does this module do") still match something.
  if (chunks.length > 1 && estimateTokens(content) <= options.maxTokens * 2) {
    chunks.push(
      buildChunk({
        repositoryId: ctx.repositoryId,
        path: ctx.path,
        symbol: null,
        kind: ChunkKind.FILE,
        language: ctx.language,
        content: buildFileSummary(ctx.path, fileImports, fileExports, boundaries),
        startLine: 1,
        endLine: lines.length,
        metadata: {
          imports: fileImports,
          exports: fileExports,
          route: null,
          linkedTestPath,
          parentSymbol: null,
          docComment: null,
          isPartial: false,
          partIndex: null,
        },
      }),
    );
  }

  return chunks.length > 0 ? chunks : windowChunks(ctx, fileImports, fileExports, linkedTestPath);
}

interface DeclarationBoundary {
  symbol: string;
  kind: ChunkKind;
  startLine: number;
  endLine: number;
  parentSymbol: string | null;
  route: { method: string; path: string } | null;
}

function findDeclarationBoundaries(
  lines: readonly string[],
  language: string,
): DeclarationBoundary[] {
  const isIndentBased = language === 'python';
  const boundaries: DeclarationBoundary[] = [];

  let currentClass: string | null = null;
  let currentClassIndent = -1;

  for (const [index, line] of lines.entries()) {
    if (!line || !line.trim()) continue;

    const lineNumber = index + 1;
    const indent = line.length - line.trimStart().length;

    // Leaving the class body resets the parent-symbol attribution.
    if (currentClass !== null && indent <= currentClassIndent && line.trim().length > 0) {
      const stillInside = isIndentBased ? indent > currentClassIndent : line.trim() !== '}';
      if (!stillInside) {
        currentClass = null;
        currentClassIndent = -1;
      }
    }

    const route = matchRoute(lines, index);
    const test = matchTest(line);

    if (test) {
      boundaries.push({
        symbol: test,
        kind: ChunkKind.TEST_CASE,
        startLine: lineNumber,
        endLine: findBlockEnd(lines, index, isIndentBased),
        parentSymbol: currentClass,
        route: null,
      });
      continue;
    }

    for (const { kind, pattern } of DECLARATION_PATTERNS) {
      const match = pattern.exec(line);
      if (!match?.[1]) continue;

      const symbol = match[1];
      const endLine = findBlockEnd(lines, index, isIndentBased);

      if (kind === ChunkKind.CLASS) {
        currentClass = symbol;
        currentClassIndent = indent;
      }

      boundaries.push({
        symbol: currentClass && kind === ChunkKind.FUNCTION ? `${currentClass}.${symbol}` : symbol,
        kind: route ? ChunkKind.ROUTE : currentClass && kind === ChunkKind.FUNCTION ? ChunkKind.METHOD : kind,
        startLine: lineNumber,
        endLine,
        parentSymbol: currentClass,
        route,
      });
      break;
    }
  }

  // Drop boundaries fully contained in an earlier one, except methods inside a
  // class: those are the most useful retrieval unit and are kept deliberately.
  return boundaries.filter((boundary, i) => {
    if (boundary.kind === ChunkKind.METHOD || boundary.kind === ChunkKind.ROUTE) return true;
    return !boundaries.some(
      (other, j) =>
        j !== i &&
        other.kind === ChunkKind.CLASS &&
        other.startLine < boundary.startLine &&
        other.endLine >= boundary.endLine,
    );
  });
}

function matchRoute(
  lines: readonly string[],
  index: number,
): { method: string; path: string } | null {
  // A decorator can sit on the line above the handler, so look back one line.
  for (const offset of [0, -1, -2]) {
    const line = lines[index + offset];
    if (!line) continue;

    for (const pattern of ROUTE_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.[1]) {
        return { method: match[1].toUpperCase(), path: match[2] ?? '/' };
      }
    }
  }
  return null;
}

function matchTest(line: string): string | null {
  for (const pattern of TEST_PATTERNS) {
    const match = pattern.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

function findBlockEnd(lines: readonly string[], startIndex: number, isIndentBased: boolean): number {
  const startLine = lines[startIndex] ?? '';
  const baseIndent = startLine.length - startLine.trimStart().length;

  if (isIndentBased) {
    for (let i = startIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) break;
      if (!line.trim()) continue;

      const indent = line.length - line.trimStart().length;
      if (indent <= baseIndent) return i;
    }
    return lines.length;
  }

  let depth = 0;
  let seenBrace = false;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    for (const char of line) {
      if (char === '{') {
        depth += 1;
        seenBrace = true;
      } else if (char === '}') {
        depth -= 1;
        if (seenBrace && depth === 0) return i + 1;
      }
    }

    // Single-line declarations (type aliases, arrow expressions) never open a brace.
    if (!seenBrace && (line.trimEnd().endsWith(';') || line.trimEnd().endsWith(','))) {
      return i + 1;
    }

    // Guard against a malformed file consuming the whole rest of the content.
    if (i - startIndex > 600) return i + 1;
  }

  return lines.length;
}

function windowChunks(
  ctx: ChunkContext,
  imports: string[],
  exports: string[],
  linkedTestPath: string | null,
): CodeChunk[] {
  const lines = ctx.content.split('\n');
  const maxChars = Math.floor(ctx.options.maxTokens * 3.6);
  const chunks: CodeChunk[] = [];

  let buffer: string[] = [];
  let bufferChars = 0;
  let startLine = 1;

  const flush = (endLine: number): void => {
    if (buffer.length === 0) return;

    chunks.push(
      buildChunk({
        repositoryId: ctx.repositoryId,
        path: ctx.path,
        symbol: null,
        kind: ChunkKind.FILE,
        language: ctx.language,
        content: buffer.join('\n'),
        startLine,
        endLine,
        metadata: {
          imports,
          exports,
          route: null,
          linkedTestPath,
          parentSymbol: null,
          docComment: null,
          isPartial: chunks.length > 0,
          partIndex: chunks.length,
        },
      }),
    );

    buffer = [];
    bufferChars = 0;
  };

  for (const [index, line] of lines.entries()) {
    if (bufferChars + line.length > maxChars && buffer.length > 0) {
      flush(index);
      startLine = index + 1;
    }
    buffer.push(line);
    bufferChars += line.length + 1;
  }

  flush(lines.length);
  return chunks;
}

// ---------------------------------------------------------------- markdown

function chunkMarkdown(ctx: ChunkContext): CodeChunk[] {
  const lines = ctx.content.split('\n');
  const chunks: CodeChunk[] = [];

  let heading: string | null = null;
  let buffer: string[] = [];
  let startLine = 1;
  let inCodeFence = false;

  const flush = (endLine: number): void => {
    const body = buffer.join('\n').trim();
    if (!body || estimateTokens(body) < 10) {
      buffer = [];
      return;
    }

    chunks.push(
      buildChunk({
        repositoryId: ctx.repositoryId,
        path: ctx.path,
        symbol: heading,
        kind: ChunkKind.DOC_SECTION,
        language: 'markdown',
        content: truncateToTokens(body, ctx.options.maxTokens),
        startLine,
        endLine,
        metadata: emptyMetadata(),
      }),
    );

    buffer = [];
  };

  for (const [index, line] of lines.entries()) {
    // A "## " inside a fenced code block is not a heading.
    if (line.trimStart().startsWith('```')) inCodeFence = !inCodeFence;

    const headingMatch = !inCodeFence ? /^(#{1,3})\s+(.+)$/.exec(line) : null;

    if (headingMatch) {
      flush(index);
      heading = headingMatch[2]?.trim() ?? null;
      startLine = index + 1;
      buffer = [line];
      continue;
    }

    buffer.push(line);
  }

  flush(lines.length);
  return chunks;
}

// ---------------------------------------------------------------- schemas

function chunkPrismaSchema(ctx: ChunkContext): CodeChunk[] {
  const lines = ctx.content.split('\n');
  const chunks: CodeChunk[] = [];

  for (const [index, line] of lines.entries()) {
    const match = /^\s*(model|enum|type)\s+([A-Za-z_][\w]*)/.exec(line);
    if (!match?.[2]) continue;

    const endLine = findBlockEnd(lines, index, false);
    const body = lines.slice(index, endLine).join('\n');

    chunks.push(
      buildChunk({
        repositoryId: ctx.repositoryId,
        path: ctx.path,
        symbol: match[2],
        kind: ChunkKind.SCHEMA_MODEL,
        language: 'prisma',
        content: body,
        startLine: index + 1,
        endLine,
        metadata: emptyMetadata(),
      }),
    );
  }

  return chunks;
}

function chunkSql(ctx: ChunkContext): CodeChunk[] {
  const statements = ctx.content.split(/;\s*\n/);
  const chunks: CodeChunk[] = [];
  let lineCursor = 1;

  for (const statement of statements) {
    const trimmed = statement.trim();
    const lineCount = statement.split('\n').length;

    if (trimmed.length > 0) {
      const nameMatch =
        /(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|FUNCTION)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?([\w.]+)"?/i.exec(
          trimmed,
        );

      chunks.push(
        buildChunk({
          repositoryId: ctx.repositoryId,
          path: ctx.path,
          symbol: nameMatch?.[1] ?? null,
          kind: ChunkKind.SCHEMA_MODEL,
          language: 'sql',
          content: `${trimmed};`,
          startLine: lineCursor,
          endLine: lineCursor + lineCount - 1,
          metadata: emptyMetadata(),
        }),
      );
    }

    lineCursor += lineCount;
  }

  return chunks;
}

// ---------------------------------------------------------------- helpers

function buildChunk(params: {
  repositoryId: string;
  path: string;
  symbol: string | null;
  kind: ChunkKind;
  language: string;
  content: string;
  startLine: number;
  endLine: number;
  metadata: ChunkMetadata;
}): CodeChunk {
  const contentHash = createHash('sha256').update(params.content).digest('hex');

  // Deterministic id: the same content at the same location always yields the
  // same id, which is what makes incremental re-indexing a hash comparison
  // rather than a diff.
  const id = createHash('sha256')
    .update(`${params.repositoryId}|${params.path}|${params.symbol ?? ''}|${contentHash}`)
    .digest('hex')
    .slice(0, 32);

  return {
    id,
    repositoryId: params.repositoryId,
    path: params.path,
    symbol: params.symbol,
    kind: params.kind,
    language: params.language,
    content: params.content,
    startLine: params.startLine,
    endLine: params.endLine,
    tokenCount: estimateTokens(params.content),
    contentHash,
    metadata: params.metadata,
  };
}

function emptyMetadata(): ChunkMetadata {
  return {
    imports: [],
    exports: [],
    route: null,
    linkedTestPath: null,
    parentSymbol: null,
    docComment: null,
    isPartial: false,
    partIndex: null,
  };
}

export function extractImports(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*from\s+([\w.]+)\s+import/gm,
    /^\s*import\s+([\w.]+)\s*$/gm,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) specifiers.add(match[1]);
    }
  }

  return [...specifiers].slice(0, 100);
}

export function extractExports(content: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /export\s*\{\s*([^}]+)\s*\}/g,
    /^\s*(?:public\s+)?class\s+([A-Za-z_][\w]*)/gm,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const captured = match[1];
      if (!captured) continue;

      if (captured.includes(',')) {
        for (const part of captured.split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0]?.trim();
          if (name) names.add(name);
        }
      } else {
        names.add(captured);
      }
    }
  }

  return [...names].slice(0, 100);
}

/**
 * Find this file's conventional test file, if the repository actually contains it.
 *
 * Powers the CONVENTION retrieval strategy: when the AI suggests tests, it should
 * follow the patterns this repository already uses rather than inventing a style.
 */
function resolveLinkedTest(path: string, knownPaths: ReadonlySet<string>): string | null {
  for (const candidate of guessTestPaths(path)) {
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}

/** Doc comment immediately above a declaration, kept as separate metadata. */
function extractDocComment(lines: readonly string[], declarationLine: number): string | null {
  const collected: string[] = [];

  for (let i = declarationLine - 2; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined) break;

    if (line.startsWith('*') || line.startsWith('/**') || line.startsWith('//') || line.startsWith('#')) {
      collected.unshift(line.replace(/^(\/\*\*|\*\/|\*|\/\/|#)\s?/, ''));
      continue;
    }
    if (line === '' && collected.length === 0) continue;
    break;
  }

  const text = collected.join(' ').trim();
  return text.length > 0 ? text.slice(0, 1000) : null;
}

function splitOversized(body: string, maxTokens: number, signature: string): string[] {
  const maxChars = Math.floor(maxTokens * 3.6);
  const lines = body.split('\n');
  const parts: string[] = [];

  let buffer: string[] = [];
  let chars = 0;

  for (const line of lines) {
    if (chars + line.length > maxChars && buffer.length > 0) {
      parts.push(buffer.join('\n'));
      // Repeat the signature so each fragment stays self-describing.
      buffer = [`${signature}  // …continued`];
      chars = signature.length;
    }
    buffer.push(line);
    chars += line.length + 1;
  }

  if (buffer.length > 0) parts.push(buffer.join('\n'));
  return parts;
}

function truncateToTokens(content: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * 3.6);
  if (content.length <= maxChars) return content;

  const slice = content.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf('\n');
  return lastNewline > maxChars * 0.6 ? slice.slice(0, lastNewline) : slice;
}

/**
 * Compact structural summary used as the file-level chunk.
 *
 * Embedding an entire file competes with its own symbol chunks and dilutes them.
 * A summary of imports, exports and declarations answers "what is this module
 * for" without that interference.
 */
function buildFileSummary(
  path: string,
  imports: readonly string[],
  exports: readonly string[],
  boundaries: readonly DeclarationBoundary[],
): string {
  const lines = [`File: ${path}`];

  if (exports.length > 0) lines.push(`Exports: ${exports.slice(0, 25).join(', ')}`);
  if (imports.length > 0) lines.push(`Imports: ${imports.slice(0, 25).join(', ')}`);

  if (boundaries.length > 0) {
    lines.push('Declarations:');
    for (const boundary of boundaries.slice(0, 40)) {
      const routeNote = boundary.route ? ` [${boundary.route.method} ${boundary.route.path}]` : '';
      lines.push(`  - ${boundary.kind} ${boundary.symbol}${routeNote}`);
    }
  }

  return lines.join('\n');
}
