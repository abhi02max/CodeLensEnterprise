/**
 * Cyclomatic complexity estimation.
 *
 * Computed from decision-point counting over tokenized source rather than a real
 * AST. That is a deliberate tradeoff worth being explicit about:
 *
 *   - a full parser per language (Tree-sitter) is the correct long-term answer
 *     and is planned, but it adds native build steps to every deployment target
 *   - the ML model consumes complexity as a *delta* between the before and after
 *     sides of the same diff, and a consistent estimator cancels most of its own
 *     bias in a subtraction
 *   - strings and comments are stripped first, which removes the failure mode
 *     that makes naive regex counting useless (`if` inside a string literal)
 *
 * So: this is a stable, cheap proxy suitable for a feature vector, not a metric
 * to report to a developer as ground truth. `functionCount` and
 * `maxFunctionComplexity` come with the same caveat.
 */

export interface ComplexityResult {
  /** Sum of cyclomatic complexity across detected functions. */
  total: number;
  functionCount: number;
  maxFunctionComplexity: number;
  /** Non-blank, non-comment lines. */
  logicalLines: number;
  /** Deepest block nesting. High values correlate with review difficulty. */
  maxNestingDepth: number;
  functions: FunctionComplexity[];
}

export interface FunctionComplexity {
  name: string;
  complexity: number;
  startLine: number;
  lineCount: number;
}

/**
 * Strip comments and string literals.
 *
 * Runs before any counting so that `const message = "if you see this, error"` and
 * `// TODO: handle the || case` do not inflate the score. Replacement preserves
 * newlines so line numbers stay accurate.
 */
export function stripCommentsAndStrings(source: string, language: string): string {
  const isPython = language === 'python';
  const result: string[] = [];

  let index = 0;
  const length = source.length;

  while (index < length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    // ---- comments
    if (!isPython && char === '/' && next === '/') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }

    if (!isPython && char === '/' && next === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') result.push('\n');
        index += 1;
      }
      index += 2;
      continue;
    }

    if (isPython && char === '#') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }

    // ---- triple-quoted strings (Python docstrings)
    if (isPython && (char === '"' || char === "'") && next === char && source[index + 2] === char) {
      const quote = char.repeat(3);
      index += 3;
      while (index < length && !source.startsWith(quote, index)) {
        if (source[index] === '\n') result.push('\n');
        index += 1;
      }
      index += 3;
      continue;
    }

    // ---- string and template literals
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index += 1;

      while (index < length) {
        const inner = source[index];

        if (inner === '\\') {
          index += 2;
          continue;
        }
        if (inner === quote) {
          index += 1;
          break;
        }
        // Template interpolations contain real code, so keep their contents.
        if (quote === '`' && inner === '$' && source[index + 1] === '{') {
          let depth = 1;
          index += 2;
          result.push('  ');
          while (index < length && depth > 0) {
            const c = source[index] ?? '';
            if (c === '{') depth += 1;
            if (c === '}') depth -= 1;
            if (depth > 0) result.push(c);
            index += 1;
          }
          continue;
        }
        if (inner === '\n') result.push('\n');
        index += 1;
      }
      continue;
    }

    result.push(char);
    index += 1;
  }

  return result.join('');
}

/**
 * Decision points that each add one to cyclomatic complexity.
 *
 * `else` is excluded on purpose: in the standard definition it does not create a
 * new independent path, the `if` already accounted for the branch. Counting it
 * would double-charge every conditional.
 */
const DECISION_PATTERNS: ReadonlyArray<{ pattern: RegExp; weight: number }> = [
  { pattern: /\bif\s*\(/g, weight: 1 },
  { pattern: /\belif\b/g, weight: 1 },
  { pattern: /\bfor\s*[(\w]/g, weight: 1 },
  { pattern: /\bwhile\s*[(\w]/g, weight: 1 },
  { pattern: /\bcase\s+/g, weight: 1 },
  { pattern: /\bcatch\s*[({]/g, weight: 1 },
  { pattern: /\bexcept\b/g, weight: 1 },
  { pattern: /&&/g, weight: 1 },
  { pattern: /\|\|/g, weight: 1 },
  { pattern: /\?\?/g, weight: 1 },
  // Ternary: matches `? x :` while avoiding `?.` and `??`.
  { pattern: /\?(?![.?])[^;\n]*?:/g, weight: 1 },
  // Optional chaining is a guarded path, though a cheap one.
  { pattern: /\?\./g, weight: 1 },
];

const FUNCTION_PATTERNS: readonly RegExp[] = [
  // function foo(, async function foo(
  /(?:^|\s)(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g,
  // const foo = (...) =>  /  const foo = async (...) =>
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g,
  // class methods and object methods: foo(...) {  /  async foo(...) {
  /(?:^|\n)\s*(?:public|private|protected|static|readonly|async|\*)*\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{/g,
  // Python
  /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/g,
];

export function analyzeComplexity(source: string, language: string): ComplexityResult {
  if (!source.trim()) {
    return {
      total: 0,
      functionCount: 0,
      maxFunctionComplexity: 0,
      logicalLines: 0,
      maxNestingDepth: 0,
      functions: [],
    };
  }

  const cleaned = stripCommentsAndStrings(source, language);
  const lines = cleaned.split('\n');

  const logicalLines = lines.filter((line) => line.trim().length > 0).length;
  const maxNestingDepth = computeMaxNesting(cleaned, language);

  const functions = extractFunctions(cleaned, language);

  // Files with no recognized function (top-level scripts, config, SQL) still
  // carry decision complexity, so attribute it to a synthetic module scope.
  if (functions.length === 0) {
    const total = countDecisionPoints(cleaned) + 1;
    return {
      total,
      functionCount: 0,
      maxFunctionComplexity: total,
      logicalLines,
      maxNestingDepth,
      functions: [{ name: '<module>', complexity: total, startLine: 1, lineCount: lines.length }],
    };
  }

  const total = functions.reduce((sum, fn) => sum + fn.complexity, 0);
  const maxFunctionComplexity = functions.reduce((max, fn) => Math.max(max, fn.complexity), 0);

  return {
    total,
    functionCount: functions.length,
    maxFunctionComplexity,
    logicalLines,
    maxNestingDepth,
    functions,
  };
}

function countDecisionPoints(source: string): number {
  let count = 0;

  for (const { pattern, weight } of DECISION_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = source.match(pattern);
    if (matches) count += matches.length * weight;
  }

  return count;
}

/**
 * Locate function bodies and score each independently.
 *
 * Bodies are delimited by brace matching for C-family languages and by
 * indentation for Python. Nested functions are attributed to their enclosing
 * function, which matches how a reviewer reads the code.
 */
function extractFunctions(source: string, language: string): FunctionComplexity[] {
  const isPython = language === 'python';
  const found: FunctionComplexity[] = [];
  const seenOffsets = new Set<number>();

  for (const pattern of FUNCTION_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(source)) !== null) {
      const offset = match.index;
      if (seenOffsets.has(offset)) continue;
      seenOffsets.add(offset);

      const name = match[1] ?? '<anonymous>';
      if (RESERVED_NON_FUNCTIONS.has(name)) continue;

      const body = isPython
        ? extractPythonBody(source, offset)
        : extractBracedBody(source, pattern.lastIndex - 1);

      if (!body) continue;

      found.push({
        name,
        complexity: countDecisionPoints(body.text) + 1,
        startLine: source.slice(0, offset).split('\n').length,
        lineCount: body.text.split('\n').length,
      });
    }
  }

  return found.sort((a, b) => a.startLine - b.startLine);
}

function extractBracedBody(source: string, fromIndex: number): { text: string } | null {
  const openIndex = source.indexOf('{', fromIndex);
  if (openIndex === -1) return null;

  // An arrow function may have a concise body with no braces at all.
  const arrowIndex = source.indexOf('=>', fromIndex);
  if (arrowIndex !== -1 && arrowIndex < openIndex) {
    const semicolon = source.indexOf(';', arrowIndex);
    const newline = source.indexOf('\n', arrowIndex);
    const end = Math.min(
      semicolon === -1 ? source.length : semicolon,
      newline === -1 ? source.length : newline,
    );
    if (end < openIndex) return { text: source.slice(arrowIndex, end) };
  }

  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { text: source.slice(openIndex, i + 1) };
    }
  }

  // Unbalanced braces: the diff gave us a fragment, not a whole file.
  return { text: source.slice(openIndex) };
}

function extractPythonBody(source: string, fromIndex: number): { text: string } | null {
  const lines = source.slice(fromIndex).split('\n');
  const header = lines[0];
  if (header === undefined) return null;

  const baseIndent = header.length - header.trimStart().length;
  const body: string[] = [header];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;

    if (line.trim().length === 0) {
      body.push(line);
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    body.push(line);
  }

  return { text: body.join('\n') };
}

function computeMaxNesting(source: string, language: string): number {
  if (language === 'python') {
    let max = 0;
    for (const line of source.split('\n')) {
      if (line.trim().length === 0) continue;
      const indent = line.length - line.trimStart().length;
      max = Math.max(max, Math.floor(indent / 4));
    }
    return max;
  }

  let depth = 0;
  let max = 0;
  for (const char of source) {
    if (char === '{') {
      depth += 1;
      max = Math.max(max, depth);
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return max;
}

/** Control-flow keywords that match the method pattern but are not functions. */
const RESERVED_NON_FUNCTIONS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'do', 'else',
  'try', 'finally', 'with', 'yield', 'await', 'new', 'delete', 'void', 'in',
  'of', 'class', 'constructor', 'super', 'this', 'import', 'export', 'require',
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll',
  'afterAll', 'and', 'or', 'not', 'elif', 'except', 'lambda', 'print',
]);

/**
 * Before/after complexity for one changed file.
 *
 * Both sides are reconstructed from the diff rather than fetched, so this costs
 * nothing extra in API calls. The delta is what the risk model consumes: a
 * negative value means the PR simplified the code, and the model is allowed to
 * learn that this lowers risk.
 */
export function complexityDelta(
  before: string,
  after: string,
  language: string,
): {
  before: number;
  after: number;
  delta: number;
  functionsChanged: number;
  maxFunctionComplexity: number;
} {
  const beforeResult = analyzeComplexity(before, language);
  const afterResult = analyzeComplexity(after, language);

  return {
    before: beforeResult.total,
    after: afterResult.total,
    delta: afterResult.total - beforeResult.total,
    functionsChanged: Math.max(beforeResult.functionCount, afterResult.functionCount),
    maxFunctionComplexity: afterResult.maxFunctionComplexity,
  };
}
