import {
  AiFileReviewSchema,
  AiReviewSchema,
  ApprovalRecommendation,
  LARGE_PR_FILE_THRESHOLD,
  LARGE_PR_LINE_THRESHOLD,
  Severity,
  chunkArray,
  extractJson,
  filterUnsupportedFindings,
  reconcileRecommendation,
  toErrorMessage,
  type AiFinding,
  type AiReview,
  type LlmMessage,
  type LlmProvider,
  type LlmUsage,
  type ToolLogger,
} from '@codelens/shared';
import {
  buildFileBatchMessages,
  buildRepairMessages,
  buildReducePrompt,
  buildReviewMessages,
  buildTestSuggestionMessages,
  type ReviewPromptInput,
} from './prompts';

/**
 * AI review generation.
 *
 * Three concerns live here, and each exists because the naive version fails in
 * practice:
 *
 *   1. SCHEMA ENFORCEMENT WITH REPAIR. Models produce structurally invalid JSON
 *      often enough that failing the review over it would be unacceptable. A
 *      single repair attempt that shows the model its own output and the
 *      validation errors recovers the large majority of cases, and is far cheaper
 *      than regenerating from scratch.
 *
 *   2. EVIDENCE FILTERING. Security and critical findings must cite a real
 *      ToolRun id. This runs after parsing, before persistence, and drops what it
 *      cannot verify. It is the single highest-leverage hallucination control in
 *      the system, because the categories it guards are exactly the ones a
 *      reviewer is most likely to act on without checking.
 *
 *   3. MAP-REDUCE FOR LARGE DIFFS. A single pass over 200 files produces vague,
 *      repetitive output as earlier files fall out of effective attention. Files
 *      are reviewed in batches and synthesized in a second call.
 */

export interface ReviewGeneratorDependencies {
  provider: LlmProvider;
  logger: ToolLogger;
  temperature: number;
  maxOutputTokens: number;
}

export interface GeneratedReview {
  review: AiReview;
  usage: LlmUsage;
  costCents: number;
  model: string;
  /** Findings dropped for missing or unverifiable evidence. */
  droppedFindings: Array<{ finding: AiFinding; reason: string }>;
  usedMapReduce: boolean;
  /** True when the first response failed validation and was repaired. */
  requiredRepair: boolean;
  effectiveRecommendation: ApprovalRecommendation;
  policyOverridden: boolean;
  policyReasons: string[];
}

export class ReviewGenerator {
  constructor(private readonly deps: ReviewGeneratorDependencies) {}

  async generate(
    input: ReviewPromptInput,
    options: {
      validEvidenceIds: ReadonlySet<string>;
      riskScore: number | null;
      riskScoreGate: number;
      blockingSeverity: Severity;
      signal: AbortSignal;
    },
  ): Promise<GeneratedReview> {
    const isLarge =
      input.files.length > LARGE_PR_FILE_THRESHOLD ||
      input.pullRequest.additions + input.pullRequest.deletions > LARGE_PR_LINE_THRESHOLD;

    const generated = isLarge
      ? await this.generateMapReduce(input, options.signal)
      : await this.generateSinglePass(input, options.signal);

    // ---- evidence enforcement
    const { kept, dropped } = filterUnsupportedFindings(
      generated.review.findings,
      options.validEvidenceIds,
    );

    if (dropped.length > 0) {
      this.deps.logger.warn(`Dropped ${dropped.length} unsupported AI finding(s)`, {
        reasons: dropped.map((entry) => entry.reason).slice(0, 5),
      });
    }

    // ---- policy reconciliation
    //
    // The model does not get the last word. A surviving CRITICAL finding forces
    // REQUEST_CHANGES regardless of what the model concluded.
    const reconciled = reconcileRecommendation(generated.review.approvalRecommendation, {
      findings: kept,
      blockingSeverity: options.blockingSeverity,
      riskScore: options.riskScore,
      riskScoreGate: options.riskScoreGate,
      secretsDetected: input.secretsDetected.length > 0,
    });

    return {
      review: { ...generated.review, findings: kept },
      usage: generated.usage,
      costCents: generated.costCents,
      model: generated.model,
      droppedFindings: dropped,
      usedMapReduce: isLarge,
      requiredRepair: generated.requiredRepair,
      effectiveRecommendation: reconciled.recommendation,
      policyOverridden: reconciled.overridden,
      policyReasons: reconciled.reasons,
    };
  }

  // -------------------------------------------------------------- single pass

  private async generateSinglePass(
    input: ReviewPromptInput,
    signal: AbortSignal,
  ): Promise<{
    review: AiReview;
    usage: LlmUsage;
    costCents: number;
    model: string;
    requiredRepair: boolean;
  }> {
    const messages = buildReviewMessages(input);

    const result = await this.completeValidated(messages, AiReviewSchema, signal);

    return {
      review: result.value,
      usage: result.usage,
      costCents: result.costCents,
      model: result.model,
      requiredRepair: result.requiredRepair,
    };
  }

  // -------------------------------------------------------------- map-reduce

  private async generateMapReduce(
    input: ReviewPromptInput,
    signal: AbortSignal,
  ): Promise<{
    review: AiReview;
    usage: LlmUsage;
    costCents: number;
    model: string;
    requiredRepair: boolean;
  }> {
    this.deps.logger.info('Large pull request: using map-reduce review', {
      files: input.files.length,
      lines: input.pullRequest.additions + input.pullRequest.deletions,
    });

    // Batch size 8 keeps each call comfortably inside effective attention while
    // still giving the model enough related files to spot local interactions.
    const batches = chunkArray(input.files, 8);

    const usage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let costCents = 0;
    let model = '';
    let requiredRepair = false;

    const fileExplanations: AiReview['fileExplanations'] = [];
    const findings: AiFinding[] = [];
    const missingTests: string[] = [];

    for (const [index, batch] of batches.entries()) {
      if (signal.aborted) break;

      const contextForBatch: Record<string, typeof input.contextPerFile[string]> = {};
      for (const file of batch) {
        const context = input.contextPerFile[file.path];
        if (context) contextForBatch[file.path] = context;
      }

      const messages = buildFileBatchMessages({
        repository: input.repository,
        pullRequestTitle: input.pullRequest.title,
        batchIndex: index,
        batchCount: batches.length,
        files: batch,
        findings: input.findings,
        evidenceIds: input.evidenceIds,
        contextPerFile: contextForBatch,
      });

      try {
        const result = await this.completeValidated(messages, AiFileReviewSchema, signal);

        fileExplanations.push(...result.value.fileExplanations);
        findings.push(...result.value.findings);
        missingTests.push(...result.value.missingTests);

        usage.promptTokens += result.usage.promptTokens;
        usage.completionTokens += result.usage.completionTokens;
        usage.totalTokens += result.usage.totalTokens;
        costCents += result.costCents;
        model = result.model;
        requiredRepair = requiredRepair || result.requiredRepair;
      } catch (error) {
        // One failed batch degrades coverage; it must not lose the batches that
        // already succeeded.
        this.deps.logger.warn(`File batch ${index + 1}/${batches.length} failed`, {
          error: toErrorMessage(error),
        });
      }
    }

    // ---- reduce
    const reduceMessages = buildReducePrompt({
      pullRequest: input.pullRequest,
      repository: input.repository,
      fileExplanations: fileExplanations.map((entry) => ({
        path: entry.path,
        whatChanged: entry.whatChanged,
        concerns: entry.concerns,
      })),
      findings: findings.map((finding) => ({
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        path: finding.path,
      })),
      missingTests,
      risk: input.risk,
      policy: input.policy,
    });

    const SynthesisSchema = AiReviewSchema.pick({
      executiveSummary: true,
      technicalSummary: true,
      approvalRecommendation: true,
      confidence: true,
      recommendationRationale: true,
      beginnerExplanation: true,
      reviewerChecklist: true,
      openQuestions: true,
      suggestedTestCases: true,
    });

    const synthesis = await this.completeValidated(reduceMessages, SynthesisSchema, signal);

    usage.promptTokens += synthesis.usage.promptTokens;
    usage.completionTokens += synthesis.usage.completionTokens;
    usage.totalTokens += synthesis.usage.totalTokens;
    costCents += synthesis.costCents;
    model = synthesis.model || model;
    requiredRepair = requiredRepair || synthesis.requiredRepair;

    return {
      review: {
        ...synthesis.value,
        fileExplanations,
        findings,
        missingTests: [...new Set(missingTests)],
      },
      usage,
      costCents,
      model,
      requiredRepair,
    };
  }

  // -------------------------------------------------------------- tests

  /**
   * Test suggestions as a separate call.
   *
   * Higher temperature than the review: writing a test is generative and benefits
   * from latitude, whereas finding a bug wants precision. Keeping it separate also
   * means a failure here does not invalidate an otherwise complete review.
   */
  async generateTestSuggestions(
    params: Parameters<typeof buildTestSuggestionMessages>[0],
    signal: AbortSignal,
  ): Promise<{
    testCases: AiReview['suggestedTestCases'];
    usage: LlmUsage;
    costCents: number;
  }> {
    const messages = buildTestSuggestionMessages(params);
    const schema = AiReviewSchema.pick({ suggestedTestCases: true });

    try {
      const result = await this.completeValidated(messages, schema, signal, {
        temperature: Math.min(this.deps.temperature + 0.3, 1),
      });

      return {
        testCases: result.value.suggestedTestCases,
        usage: result.usage,
        costCents: result.costCents,
      };
    } catch (error) {
      this.deps.logger.warn('Test suggestion generation failed', {
        error: toErrorMessage(error),
      });
      return {
        testCases: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costCents: 0,
      };
    }
  }

  // -------------------------------------------------------------- internals

  /**
   * Complete, parse, validate, and repair once on failure.
   *
   * The repair attempt is capped at one deliberately. A model that fails the
   * schema twice is not going to converge, and a retry loop on an expensive call
   * is how a cost ceiling gets breached.
   */
  private async completeValidated<T>(
    messages: LlmMessage[],
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } } },
    signal: AbortSignal,
    overrides: { temperature?: number } = {},
  ): Promise<{
    value: T;
    usage: LlmUsage;
    costCents: number;
    model: string;
    requiredRepair: boolean;
  }> {
    const completion = await this.deps.provider.complete({
      messages,
      temperature: overrides.temperature ?? this.deps.temperature,
      maxOutputTokens: this.deps.maxOutputTokens,
      jsonMode: true,
      signal,
    });

    const firstAttempt = this.tryParse(completion.content, schema);

    if (firstAttempt.ok) {
      return {
        value: firstAttempt.value,
        usage: completion.usage,
        costCents: completion.costCents,
        model: completion.model,
        requiredRepair: false,
      };
    }

    this.deps.logger.warn('AI response failed schema validation; attempting repair', {
      errors: firstAttempt.errors.slice(0, 300),
    });

    const repairMessages = buildRepairMessages({
      original: messages,
      rawResponse: completion.content,
      validationErrors: firstAttempt.errors,
    });

    const repaired = await this.deps.provider.complete({
      messages: repairMessages,
      temperature: 0,
      maxOutputTokens: this.deps.maxOutputTokens,
      jsonMode: true,
      signal,
    });

    const secondAttempt = this.tryParse(repaired.content, schema);

    const usage: LlmUsage = {
      promptTokens: completion.usage.promptTokens + repaired.usage.promptTokens,
      completionTokens: completion.usage.completionTokens + repaired.usage.completionTokens,
      totalTokens: completion.usage.totalTokens + repaired.usage.totalTokens,
    };

    if (!secondAttempt.ok) {
      throw new Error(
        `AI response failed schema validation after one repair attempt: ${secondAttempt.errors.slice(0, 500)}`,
      );
    }

    return {
      value: secondAttempt.value,
      usage,
      costCents: completion.costCents + repaired.costCents,
      model: repaired.model,
      requiredRepair: true,
    };
  }

  private tryParse<T>(
    raw: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } } },
  ): { ok: true; value: T } | { ok: false; errors: string } {
    let parsed: unknown;

    try {
      // Tolerates markdown fences and surrounding prose, which models emit even
      // in JSON mode.
      parsed = extractJson(raw);
    } catch (error) {
      return { ok: false, errors: `Response was not parseable JSON: ${toErrorMessage(error)}` };
    }

    const result = schema.safeParse(parsed);

    if (result.success) return { ok: true, value: result.data };

    const errors = result.error.issues
      .slice(0, 12)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    return { ok: false, errors };
  }
}
