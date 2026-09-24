import { z } from 'zod';
import {
  ApprovalRecommendation,
  EVIDENCE_REQUIRED_CATEGORIES,
  FindingCategory,
  Severity,
} from '../enums';

/**
 * The GenAI review contract.
 *
 * Everything the model produces is validated against these schemas before it
 * reaches the database or the UI. Two rules do most of the work:
 *
 *   1. The shape is closed. A model that invents a field gets it stripped.
 *   2. Findings in evidence-required categories must cite a ToolRun id. A
 *      "SQL injection on line 42" with no backing analyzer output is dropped.
 *
 * Rule 2 is the difference between a review a senior engineer trusts and one
 * they learn to ignore.
 */

export const AiFindingSchema = z.object({
  category: z.nativeEnum(FindingCategory),
  severity: z.nativeEnum(Severity),
  title: z.string().min(3).max(200),
  explanation: z.string().min(10).max(4000),
  path: z.string().max(500).nullable(),
  line: z.number().int().min(1).nullable(),
  /** Concrete replacement code, not prose. Null when no safe fix is obvious. */
  suggestedFix: z.string().max(6000).nullable(),
  /**
   * ToolRun ids backing this finding. Enforced non-empty for the categories in
   * EVIDENCE_REQUIRED_CATEGORIES by {@link filterUnsupportedFindings}.
   */
  evidence: z.array(z.string().max(64)).default([]),
  /** Model's own confidence. Low-confidence findings render de-emphasized. */
  confidence: z.number().min(0).max(1).default(0.7),
});
export type AiFinding = z.infer<typeof AiFindingSchema>;

export const FileExplanationSchema = z.object({
  path: z.string().min(1).max(500),
  whatChanged: z.string().min(5).max(2000),
  /** Consequences for the rest of the system, grounded in retrieved context. */
  whyItMatters: z.string().min(5).max(2000),
  concerns: z.array(z.string().max(1000)).max(20).default([]),
  /** Paths from RAG context the model actually used to reason about this file. */
  relatedContextPaths: z.array(z.string().max(500)).max(20).default([]),
});
export type FileExplanation = z.infer<typeof FileExplanationSchema>;

export const SuggestedTestCaseSchema = z.object({
  description: z.string().min(5).max(500),
  /** Target test file, following the conventions RAG found in this repo. */
  path: z.string().min(1).max(500),
  /** Runnable test code in the repository's existing test framework. */
  code: z.string().min(10).max(8000),
  /** What this test protects against, tied back to a finding when possible. */
  rationale: z.string().max(1000),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
});
export type SuggestedTestCase = z.infer<typeof SuggestedTestCaseSchema>;

export const ChecklistItemSchema = z.object({
  item: z.string().min(3).max(300),
  rationale: z.string().max(1000),
  /** True when this item came from org policy rather than the model. */
  fromPolicy: z.boolean().default(false),
  /** Model's read on whether the PR satisfies it. Advisory only. */
  status: z.enum(['LIKELY_SATISFIED', 'NEEDS_ATTENTION', 'CANNOT_DETERMINE']),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const AiReviewSchema = z.object({
  /** Two or three sentences a non-engineer manager can follow. */
  executiveSummary: z.string().min(20).max(2000),
  /** What actually changed and how, for the reviewer. */
  technicalSummary: z.string().min(20).max(6000),
  approvalRecommendation: z.nativeEnum(ApprovalRecommendation),
  /** Confidence in the recommendation, not in the prose. */
  confidence: z.number().min(0).max(1),
  /** One-line justification for the recommendation. */
  recommendationRationale: z.string().min(10).max(1000),
  fileExplanations: z.array(FileExplanationSchema).max(300).default([]),
  findings: z.array(AiFindingSchema).max(200).default([]),
  missingTests: z.array(z.string().max(500)).max(50).default([]),
  suggestedTestCases: z.array(SuggestedTestCaseSchema).max(30).default([]),
  /** Plain-language walkthrough for someone new to this codebase. */
  beginnerExplanation: z.string().min(20).max(6000),
  reviewerChecklist: z.array(ChecklistItemSchema).max(40).default([]),
  /** Questions the model could not resolve from the available context. */
  openQuestions: z.array(z.string().max(500)).max(20).default([]),
});
export type AiReview = z.infer<typeof AiReviewSchema>;

/**
 * Partial schema for the map phase of a large-PR review. A single pass over a
 * 200-file diff degrades badly, so files are reviewed in batches and synthesized
 * afterwards.
 */
export const AiFileReviewSchema = z.object({
  fileExplanations: z.array(FileExplanationSchema).max(50),
  findings: z.array(AiFindingSchema).max(60).default([]),
  missingTests: z.array(z.string().max(500)).max(20).default([]),
});
export type AiFileReview = z.infer<typeof AiFileReviewSchema>;

// ---------------------------------------------------------------- guardrails

export interface EvidenceFilterResult {
  kept: AiFinding[];
  /** Findings removed for missing evidence, retained for observability. */
  dropped: Array<{ finding: AiFinding; reason: string }>;
}

/**
 * Drop findings in evidence-required categories that cite no valid ToolRun.
 *
 * `validToolRunIds` is the set of runs that actually executed for this review,
 * so a model that fabricates a plausible-looking id is caught too.
 */
export function filterUnsupportedFindings(
  findings: readonly AiFinding[],
  validToolRunIds: ReadonlySet<string>,
): EvidenceFilterResult {
  const kept: AiFinding[] = [];
  const dropped: Array<{ finding: AiFinding; reason: string }> = [];

  for (const finding of findings) {
    const needsEvidence =
      EVIDENCE_REQUIRED_CATEGORIES.includes(finding.category) ||
      finding.severity === Severity.CRITICAL;

    if (!needsEvidence) {
      kept.push(finding);
      continue;
    }

    const citedValid = finding.evidence.filter((id) => validToolRunIds.has(id));

    if (citedValid.length === 0) {
      dropped.push({
        finding,
        reason:
          finding.evidence.length === 0
            ? `${finding.category}/${finding.severity} finding cited no evidence`
            : `${finding.category}/${finding.severity} finding cited unknown tool run ids: ${finding.evidence.join(', ')}`,
      });
      continue;
    }

    kept.push({ ...finding, evidence: citedValid });
  }

  return { kept, dropped };
}

/**
 * Reconcile the model's recommendation with org policy.
 *
 * The model does not get the last word: if a CRITICAL finding survived
 * validation, the recommendation is forced to REQUEST_CHANGES regardless of what
 * the model concluded. Policy beats persuasion.
 */
export function reconcileRecommendation(
  modelRecommendation: ApprovalRecommendation,
  params: {
    findings: readonly AiFinding[];
    blockingSeverity: Severity;
    riskScore: number | null;
    riskScoreGate: number;
    secretsDetected: boolean;
  },
): { recommendation: ApprovalRecommendation; overridden: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (params.secretsDetected) {
    reasons.push('A potential secret was detected in the diff');
  }

  const severityOrder: Severity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const gateIndex = severityOrder.indexOf(params.blockingSeverity);
  const blocking = params.findings.filter(
    (f) => severityOrder.indexOf(f.severity) >= gateIndex,
  );
  if (blocking.length > 0) {
    reasons.push(
      `${blocking.length} finding(s) at or above the ${params.blockingSeverity} policy threshold`,
    );
  }

  if (params.riskScore !== null && params.riskScore >= params.riskScoreGate) {
    reasons.push(
      `Risk score ${params.riskScore} meets the organization gate of ${params.riskScoreGate}`,
    );
  }

  if (reasons.length > 0 && modelRecommendation === ApprovalRecommendation.APPROVE) {
    return {
      recommendation: ApprovalRecommendation.REQUEST_CHANGES,
      overridden: true,
      reasons,
    };
  }

  return { recommendation: modelRecommendation, overridden: false, reasons };
}

// ---------------------------------------------------------------- persisted view

export interface AiReviewView extends AiReview {
  id: string;
  reviewRunId: string;
  provider: string;
  model: string;
  promptVersion: string;
  tokenUsage: { prompt: number; completion: number; total: number };
  costCents: number;
  createdAt: string;
  /** Recommendation after policy reconciliation, plus why it differs. */
  effectiveRecommendation: ApprovalRecommendation;
  policyOverridden: boolean;
  policyReasons: string[];
  /** Count of findings removed by the evidence filter. Shown to admins. */
  droppedFindingCount: number;
  /** True when the review ran map-reduce over a large diff. */
  usedMapReduce: boolean;
}

// ---------------------------------------------------------------- llm plumbing

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmCompletion {
  content: string;
  usage: LlmUsage;
  model: string;
  finishReason: string;
  costCents: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(params: {
    messages: LlmMessage[];
    temperature?: number;
    maxOutputTokens?: number;
    /** Request strict JSON output where the provider supports it. */
    jsonMode?: boolean;
    signal?: AbortSignal;
  }): Promise<LlmCompletion>;
}
