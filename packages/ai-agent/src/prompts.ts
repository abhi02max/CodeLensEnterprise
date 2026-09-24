import {
  PROMPT_VERSION,
  type LlmMessage,
  type PrMetricsView,
  type RetrievedChunk,
  type ReviewPolicy,
  type RiskReason,
  type StaticFinding,
} from '@codelens/shared';

/**
 * Prompt templates.
 *
 * The design goal is to make the model an *interpreter of evidence* rather than a
 * source of claims. Concretely:
 *
 *   - Static findings arrive with their ToolRun id, and the model is instructed to
 *     cite that id as evidence. Findings it cannot ground get filtered out
 *     downstream, so uncited speculation has no path into the report.
 *   - Retrieved repository context is labelled with its path and the reason it was
 *     retrieved, which lets the model say "this violates the convention in
 *     docs/architecture.md" instead of offering generic advice.
 *   - The ML risk score is supplied as a signal to explain, not a verdict to
 *     agree with. Models otherwise anchor hard on a number in the prompt.
 *   - Duplication of static findings is explicitly discouraged. The deterministic
 *     analyzers already reported them; re-listing them wastes the review's
 *     attention budget on things nobody needed an LLM for.
 *
 * PROMPT_VERSION is recorded on every AiReview so an output quality change can be
 * attributed to a specific revision of these templates.
 */

export const promptVersion = PROMPT_VERSION;

const SYSTEM_PROMPT = `You are a senior staff engineer performing a code review on a GitHub pull request.

You are one part of a larger review system. Deterministic tools have already run:
static analyzers, a dependency audit, a secret scanner, complexity analysis, and a
machine-learning risk model. Their outputs are given to you as evidence.

Your job is judgement, not detection:
- Explain what this change does and what it puts at risk.
- Prioritise. Ten findings of equal weight is the same as no findings.
- Ground every claim in the diff or the provided repository context.
- Identify what the automated tools cannot see: incorrect business logic, missing
  cases, broken invariants, contract changes, and absent tests.

Rules you must follow:

1. EVIDENCE. For any finding in the SECURITY or DEPENDENCY category, or any finding
   you mark CRITICAL, you must cite at least one tool run id from the EVIDENCE
   section in its "evidence" array. A finding you cannot ground in provided evidence
   must either be reported at a lower severity in a different category, or omitted.
   Never invent an id.

2. NO DUPLICATION. Do not restate a static analyzer finding as your own. Add
   interpretation instead: why it matters here, what breaks, how to fix it.

3. SPECIFICITY. "Consider adding error handling" is worthless. Name the function,
   the input, and the failure. If you suggest a fix, write the actual code.

4. CONVENTIONS. Use the REPOSITORY CONTEXT to follow this codebase's existing
   patterns. If the change diverges from them, say which pattern and where it is
   established.

5. UNCERTAINTY. If the diff alone cannot tell you something, put it in
   openQuestions rather than guessing. Saying "I cannot determine whether callers
   handle this" is more useful than a confident wrong answer.

6. RISK SCORE. The ML risk score is a signal produced from historical patterns, not
   a conclusion. Explain or contradict it based on what you actually see in the diff.

Respond with a single JSON object matching the requested schema. No prose outside it.`;

export interface ReviewPromptInput {
  pullRequest: {
    number: number;
    title: string;
    body: string | null;
    authorLogin: string;
    baseRef: string;
    headRef: string;
    additions: number;
    deletions: number;
    changedFiles: number;
  };
  repository: {
    fullName: string;
    primaryLanguage: string | null;
    description: string | null;
  };
  commitMessages: string[];
  files: Array<{
    path: string;
    status: string;
    language: string;
    flags: string[];
    additions: number;
    deletions: number;
    /** Formatted diff, context-trimmed. Null for binary or oversized patches. */
    diff: string | null;
  }>;
  findings: StaticFinding[];
  /** Tool run ids the model may legitimately cite, keyed by analyzer. */
  evidenceIds: Record<string, string>;
  metrics: PrMetricsView | null;
  risk: {
    score: number;
    level: string;
    isBaseline: boolean;
    confidence: number;
    reasons: RiskReason[];
    predictedReviewMinutes: number | null;
    similar: Array<{ reference: string; title: string; outcome: string; similarity: number }>;
  } | null;
  /** Retrieved repository context, keyed by the changed file it relates to. */
  contextPerFile: Record<string, RetrievedChunk[]>;
  repositoryOverview: RetrievedChunk[];
  policy: Pick<ReviewPolicy, 'checklist' | 'blockingSeverity' | 'requireTestsForCodeChanges'>;
  secretsDetected: Array<{ path: string; line: number; kind: string }>;
  /** True when the diff was redacted before being sent. */
  wasRedacted: boolean;
}

export function buildReviewMessages(input: ReviewPromptInput): LlmMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildReviewUserPrompt(input) },
  ];
}

function buildReviewUserPrompt(input: ReviewPromptInput): string {
  const sections: string[] = [];

  // ---- pull request
  sections.push(
    section('PULL REQUEST', [
      `Repository: ${input.repository.fullName}` +
        (input.repository.primaryLanguage ? ` (${input.repository.primaryLanguage})` : ''),
      input.repository.description ? `Repository purpose: ${input.repository.description}` : '',
      `PR #${input.pullRequest.number}: ${input.pullRequest.title}`,
      `Author: ${input.pullRequest.authorLogin}`,
      `Branch: ${input.pullRequest.headRef} → ${input.pullRequest.baseRef}`,
      `Size: +${input.pullRequest.additions} / -${input.pullRequest.deletions} across ${input.pullRequest.changedFiles} files`,
      '',
      'Description:',
      input.pullRequest.body?.trim() || '(the author provided no description)',
      '',
      'Commits:',
      ...input.commitMessages.slice(0, 20).map((message) => `  - ${message.split('\n')[0]}`),
    ]),
  );

  // ---- evidence
  //
  // Placed before the diff on purpose: the model reads the deterministic facts
  // first, which measurably reduces invented findings compared with presenting
  // the diff and asking for analysis.
  const evidenceLines: string[] = [];

  if (Object.keys(input.evidenceIds).length > 0) {
    evidenceLines.push('Tool run ids available for citation:');
    for (const [tool, id] of Object.entries(input.evidenceIds)) {
      evidenceLines.push(`  ${tool} → "${id}"`);
    }
    evidenceLines.push('');
  }

  if (input.secretsDetected.length > 0) {
    evidenceLines.push('SECRET SCAN — credentials detected in added lines:');
    for (const hit of input.secretsDetected) {
      evidenceLines.push(`  ${hit.path}:${hit.line} — possible ${hit.kind}`);
    }
    evidenceLines.push(
      '  This is the highest priority item in the review. The credential is in git',
      '  history and must be rotated, not merely deleted in a follow-up commit.',
      '',
    );
  }

  const newFindings = input.findings.filter((finding) => !finding.preexisting);
  const oldFindings = input.findings.filter((finding) => finding.preexisting);

  if (newFindings.length > 0) {
    evidenceLines.push(`STATIC ANALYSIS — ${newFindings.length} finding(s) on lines this PR touched:`);
    for (const finding of newFindings.slice(0, 60)) {
      const location = finding.path ? `${finding.path}:${finding.line ?? '?'}` : 'repository';
      evidenceLines.push(
        `  [${finding.severity}/${finding.category}] ${finding.analyzer} ${finding.ruleId}`,
        `    ${location} — ${finding.message.replace(/\s+/g, ' ').slice(0, 400)}`,
      );
    }
    evidenceLines.push('');
  }

  if (oldFindings.length > 0) {
    evidenceLines.push(
      `PRE-EXISTING — ${oldFindings.length} finding(s) on lines this PR did NOT touch.`,
      '  Do not hold the author responsible for these. Mention one only if this',
      '  change makes it materially worse.',
      '',
    );
  }

  if (input.metrics) {
    const m = input.metrics;
    evidenceLines.push(
      'METRICS:',
      `  complexity ${m.complexityBefore} → ${m.complexityAfter} (delta ${m.complexityDelta >= 0 ? '+' : ''}${m.complexityDelta}), max function complexity ${m.maxFunctionComplexity}`,
      `  functions changed: ${m.functionsChanged}; test files changed: ${m.testFilesChanged}; test-to-code line ratio: ${m.testToCodeRatio.toFixed(2)}`,
      `  touches — auth: ${m.authFileChanged}, database: ${m.databaseFileChanged}, payment: ${m.paymentFileChanged}, config: ${m.configFileChanged}, dependencies: ${m.dependencyChanged}`,
      '',
    );
  }

  if (input.risk) {
    const r = input.risk;
    evidenceLines.push(
      `ML RISK MODEL — score ${r.score}/100 (${r.level}), model confidence ${(r.confidence * 100).toFixed(0)}%`,
      r.isBaseline
        ? '  NOTE: produced by a heuristic baseline, not a model trained on this organisation’s' +
          '\n  review history. Treat it as weak evidence and rely on the diff.'
        : '  Trained on this organisation’s historical review outcomes.',
      ...(r.reasons.length > 0
        ? [
            '  Attributed drivers (SHAP):',
            ...r.reasons
              .slice(0, 6)
              .map(
                (reason) =>
                  `    ${reason.direction === 'INCREASES_RISK' ? '↑' : '↓'} ${reason.label} = ${reason.value} — ${reason.explanation}`,
              ),
          ]
        : []),
      ...(r.predictedReviewMinutes !== null
        ? [`  Estimated human review time: ${Math.round(r.predictedReviewMinutes)} minutes`]
        : []),
      ...(r.similar.length > 0
        ? [
            '  Similar past pull requests in this repository:',
            ...r.similar
              .slice(0, 4)
              .map(
                (pr) =>
                  `    ${pr.reference} "${pr.title}" — outcome ${pr.outcome} (similarity ${(pr.similarity * 100).toFixed(0)}%)`,
              ),
          ]
        : []),
      '',
    );
  }

  sections.push(section('EVIDENCE', evidenceLines));

  // ---- repository context
  if (input.repositoryOverview.length > 0) {
    sections.push(
      section(
        'REPOSITORY CONVENTIONS',
        input.repositoryOverview.map((chunk) => formatChunk(chunk)),
      ),
    );
  }

  const contextEntries = Object.entries(input.contextPerFile).filter(
    ([, chunks]) => chunks.length > 0,
  );

  if (contextEntries.length > 0) {
    const lines: string[] = [
      'Existing code related to the changed files, retrieved from the indexed repository.',
      'Use it to judge whether this change fits the codebase.',
      '',
    ];

    for (const [path, chunks] of contextEntries) {
      lines.push(`Context for ${path}:`);
      for (const chunk of chunks) lines.push(formatChunk(chunk, '  '));
      lines.push('');
    }

    sections.push(section('REPOSITORY CONTEXT', lines));
  }

  // ---- diff
  const diffLines: string[] = [];

  if (input.wasRedacted) {
    diffLines.push(
      'NOTE: detected credentials were replaced with [REDACTED_SECRET] before sending.',
      '',
    );
  }

  for (const file of input.files) {
    diffLines.push(
      `--- ${file.path} (${file.status}, ${file.language}, +${file.additions}/-${file.deletions})` +
        (file.flags.length > 0 ? ` [${file.flags.join(', ')}]` : ''),
    );

    if (file.diff) {
      diffLines.push(file.diff, '');
    } else {
      diffLines.push('(binary, generated, or oversized — patch omitted)', '');
    }
  }

  sections.push(section('DIFF', diffLines));

  // ---- policy
  sections.push(
    section('ORGANISATION POLICY', [
      `Findings at or above ${input.policy.blockingSeverity} are treated as blocking.`,
      input.policy.requireTestsForCodeChanges
        ? 'This organisation requires tests to accompany code changes.'
        : 'Tests are encouraged but not required by policy.',
      '',
      'Required checklist items — include each in reviewerChecklist with fromPolicy=true',
      'and an assessment based on the diff:',
      ...input.policy.checklist.map((item) => `  - ${item}`),
    ]),
  );

  // ---- task
  sections.push(
    section('YOUR TASK', [
      'Produce the review as a single JSON object with exactly these fields:',
      '',
      '  executiveSummary          2-3 sentences a non-engineer can follow',
      '  technicalSummary          what changed and how, for the reviewer',
      '  approvalRecommendation    APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION',
      '  confidence                0-1, your confidence in the recommendation',
      '  recommendationRationale   one sentence justifying it',
      '  fileExplanations[]        { path, whatChanged, whyItMatters, concerns[], relatedContextPaths[] }',
      '  findings[]                { category, severity, title, explanation, path, line,',
      '                              suggestedFix, evidence[], confidence }',
      '                            category: BUG | SECURITY | PERFORMANCE | MAINTAINABILITY |',
      '                                      TESTING | STYLE | DEPENDENCY | TYPE_SAFETY',
      '                            severity: CRITICAL | HIGH | MEDIUM | LOW | INFO',
      '  missingTests[]            behaviours this change leaves untested',
      '  suggestedTestCases[]      { description, path, code, rationale, priority }',
      '                            code must be runnable in this repository’s test framework',
      '  beginnerExplanation       plain-language walkthrough for someone new to this codebase',
      '  reviewerChecklist[]       { item, rationale, fromPolicy,',
      '                              status: LIKELY_SATISFIED | NEEDS_ATTENTION | CANNOT_DETERMINE }',
      '  openQuestions[]           what you could not determine from the given context',
      '',
      'Reminder: SECURITY, DEPENDENCY and any CRITICAL finding must cite a tool run id',
      'from EVIDENCE in its evidence array, or it will be discarded.',
    ]),
  );

  return sections.join('\n\n');
}

/**
 * Map-phase prompt for large pull requests.
 *
 * A single pass over a 200-file diff degrades badly: the model loses track of
 * earlier files and produces vague, repetitive output. Files are reviewed in
 * batches here and synthesized by {@link buildReducePrompt}.
 */
export function buildFileBatchMessages(params: {
  repository: { fullName: string; primaryLanguage: string | null };
  pullRequestTitle: string;
  batchIndex: number;
  batchCount: number;
  files: ReviewPromptInput['files'];
  findings: StaticFinding[];
  evidenceIds: Record<string, string>;
  contextPerFile: Record<string, RetrievedChunk[]>;
}): LlmMessage[] {
  const lines: string[] = [
    `Repository: ${params.repository.fullName}`,
    `Pull request: ${params.pullRequestTitle}`,
    `This is batch ${params.batchIndex + 1} of ${params.batchCount}. Review only the files below.`,
    '',
  ];

  if (Object.keys(params.evidenceIds).length > 0) {
    lines.push('Tool run ids available for citation:');
    for (const [tool, id] of Object.entries(params.evidenceIds)) {
      lines.push(`  ${tool} → "${id}"`);
    }
    lines.push('');
  }

  const relevant = params.findings.filter(
    (finding) => finding.path && params.files.some((file) => file.path === finding.path),
  );

  if (relevant.length > 0) {
    lines.push('Static analysis findings for these files:');
    for (const finding of relevant.slice(0, 40)) {
      lines.push(
        `  [${finding.severity}/${finding.category}] ${finding.ruleId} at ${finding.path}:${finding.line ?? '?'}`,
        `    ${finding.message.replace(/\s+/g, ' ').slice(0, 300)}`,
      );
    }
    lines.push('');
  }

  for (const file of params.files) {
    lines.push(
      `--- ${file.path} (${file.status}, +${file.additions}/-${file.deletions})` +
        (file.flags.length > 0 ? ` [${file.flags.join(', ')}]` : ''),
    );

    const context = params.contextPerFile[file.path];
    if (context && context.length > 0) {
      lines.push('  Related existing code:');
      for (const chunk of context.slice(0, 4)) lines.push(formatChunk(chunk, '    '));
    }

    lines.push(file.diff ?? '(patch omitted)', '');
  }

  lines.push(
    'Return a JSON object with exactly these fields:',
    '  fileExplanations[]  { path, whatChanged, whyItMatters, concerns[], relatedContextPaths[] }',
    '  findings[]          { category, severity, title, explanation, path, line, suggestedFix, evidence[], confidence }',
    '  missingTests[]      behaviours these files leave untested',
    '',
    'SECURITY, DEPENDENCY and CRITICAL findings must cite a tool run id or be omitted.',
  );

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** Reduce-phase prompt: synthesize per-file results into one review. */
export function buildReducePrompt(params: {
  pullRequest: ReviewPromptInput['pullRequest'];
  repository: ReviewPromptInput['repository'];
  fileExplanations: Array<{ path: string; whatChanged: string; concerns: string[] }>;
  findings: Array<{ category: string; severity: string; title: string; path: string | null }>;
  missingTests: string[];
  risk: ReviewPromptInput['risk'];
  policy: ReviewPromptInput['policy'];
}): LlmMessage[] {
  const lines: string[] = [
    `Repository: ${params.repository.fullName}`,
    `PR #${params.pullRequest.number}: ${params.pullRequest.title}`,
    `Size: +${params.pullRequest.additions} / -${params.pullRequest.deletions} across ${params.pullRequest.changedFiles} files`,
    '',
    'Per-file reviews have already been produced for this pull request. Your job is to',
    'synthesize them into one coherent review: find the cross-file implications that',
    'no single-file review could see, and decide the overall recommendation.',
    '',
    'File reviews:',
  ];

  for (const file of params.fileExplanations) {
    lines.push(`  ${file.path}: ${file.whatChanged}`);
    for (const concern of file.concerns.slice(0, 4)) lines.push(`    - ${concern}`);
  }

  lines.push('', 'Findings already reported:');
  for (const finding of params.findings.slice(0, 60)) {
    lines.push(`  [${finding.severity}/${finding.category}] ${finding.title} (${finding.path ?? 'repository'})`);
  }

  if (params.missingTests.length > 0) {
    lines.push('', 'Test gaps already identified:');
    for (const gap of params.missingTests.slice(0, 20)) lines.push(`  - ${gap}`);
  }

  if (params.risk) {
    lines.push(
      '',
      `ML risk score: ${params.risk.score}/100 (${params.risk.level})${params.risk.isBaseline ? ' — heuristic baseline' : ''}`,
    );
  }

  lines.push(
    '',
    `Policy: findings at or above ${params.policy.blockingSeverity} are blocking.`,
    'Required checklist items:',
    ...params.policy.checklist.map((item) => `  - ${item}`),
    '',
    'Return a JSON object with these fields (do not repeat fileExplanations or findings):',
    '  executiveSummary, technicalSummary, approvalRecommendation, confidence,',
    '  recommendationRationale, beginnerExplanation, reviewerChecklist[], openQuestions[],',
    '  suggestedTestCases[]',
  );

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * Test-suggestion prompt.
 *
 * A separate call with a higher temperature. Writing a test is a generative task
 * and benefits from more latitude than finding a bug, which wants precision.
 * Separating them also keeps a failed test-generation attempt from invalidating
 * an otherwise good review.
 */
export function buildTestSuggestionMessages(params: {
  repository: { fullName: string; primaryLanguage: string | null };
  pullRequestTitle: string;
  missingTests: string[];
  files: Array<{ path: string; diff: string | null }>;
  /** Existing tests, so generated tests match the established style. */
  testExamples: RetrievedChunk[];
  framework: string | null;
}): LlmMessage[] {
  const lines: string[] = [
    `Repository: ${params.repository.fullName}`,
    `Pull request: ${params.pullRequestTitle}`,
    params.framework ? `Test framework in use: ${params.framework}` : '',
    '',
    'Write tests covering these gaps:',
    ...params.missingTests.map((gap) => `  - ${gap}`),
    '',
  ];

  if (params.testExamples.length > 0) {
    lines.push(
      'Existing tests from this repository. Match their structure, imports, naming and',
      'assertion style exactly — a test that does not fit the codebase will not be used:',
      '',
    );
    for (const example of params.testExamples.slice(0, 4)) {
      lines.push(formatChunk(example, '  '));
    }
    lines.push('');
  }

  lines.push('Code under test:', '');
  for (const file of params.files.slice(0, 15)) {
    lines.push(`--- ${file.path}`, file.diff ?? '(patch omitted)', '');
  }

  lines.push(
    'Return a JSON object: { "suggestedTestCases": [ { description, path, code, rationale, priority } ] }',
    '',
    'Requirements:',
    '  - code must be complete and runnable, not a sketch or pseudocode',
    '  - path must follow this repository’s existing test file conventions',
    '  - use the same imports, helpers and builders the example tests use',
    '  - priority is HIGH | MEDIUM | LOW',
    '  - at most 6 test cases; prefer a few high-value tests over broad coverage',
  );

  return [
    {
      role: 'system',
      content:
        'You write tests that fit an existing codebase. You match its framework, its file ' +
        'layout, its naming, and its assertion style. You never invent helpers that the ' +
        'repository does not already have. Respond only with the requested JSON object.',
    },
    { role: 'user', content: lines.filter((line) => line !== '').join('\n') },
  ];
}

/**
 * Repair prompt for a response that failed schema validation.
 *
 * Cheaper than re-running the whole review, and it usually succeeds: the model
 * had the right content and got the shape wrong.
 */
export function buildRepairMessages(params: {
  original: LlmMessage[];
  rawResponse: string;
  validationErrors: string;
}): LlmMessage[] {
  return [
    ...params.original,
    { role: 'assistant', content: params.rawResponse.slice(0, 12_000) },
    {
      role: 'user',
      content: [
        'Your response failed schema validation:',
        '',
        params.validationErrors,
        '',
        'Return the corrected JSON object only. Keep your analysis; fix the structure.',
        'Do not add commentary, markdown fences, or any text outside the JSON object.',
      ].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------- formatting

function section(title: string, lines: readonly string[]): string {
  const body = lines.filter((line) => line !== undefined).join('\n');
  return `${'='.repeat(70)}\n${title}\n${'='.repeat(70)}\n${body}`;
}

/**
 * Render a retrieved chunk with its provenance.
 *
 * The rationale is included so the model understands *why* it is seeing this
 * code, which improves how well it uses it — an existing test presented as "this
 * is the test for the guard you removed" gets used very differently from the same
 * code presented without explanation.
 */
function formatChunk(chunk: RetrievedChunk, indent = ''): string {
  const header =
    `${indent}[${chunk.path}${chunk.symbol ? ` → ${chunk.symbol}` : ''}` +
    ` lines ${chunk.startLine}-${chunk.endLine}] ${chunk.rationale}`;

  const body = chunk.content
    .split('\n')
    .map((line) => `${indent}  ${line}`)
    .join('\n');

  return `${header}\n${body}`;
}
