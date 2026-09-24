import { z } from 'zod';
import { CommentOrigin, FindingCategory, ReviewVerdict, Severity, ShareScope } from '../enums';
import { IdSchema } from './common';

// ---------------------------------------------------------------- human verdicts

export const SubmitReviewSchema = z.object({
  verdict: z.nativeEnum(ReviewVerdict),
  summary: z.string().trim().max(10_000).optional(),
  /** Checklist items the reviewer explicitly confirmed. */
  acknowledgedChecklistItems: z.array(z.string().max(300)).max(40).default([]),
  /**
   * AI findings the reviewer dismissed, with a reason. Dismissals train the
   * noise filter: a rule dismissed repeatedly across an org gets suppressed.
   */
  dismissedFindings: z
    .array(
      z.object({
        fingerprint: z.string().max(128),
        reason: z.enum(['FALSE_POSITIVE', 'ACCEPTED_RISK', 'OUT_OF_SCOPE', 'ALREADY_TRACKED']),
        note: z.string().max(1000).optional(),
      }),
    )
    .max(200)
    .default([]),
});
export type SubmitReviewInput = z.infer<typeof SubmitReviewSchema>;

export interface ReviewView {
  id: string;
  pullRequestId: string;
  reviewer: { id: string; name: string; avatarUrl: string | null };
  verdict: ReviewVerdict;
  summary: string | null;
  /** SHA the verdict applies to; new commits mark it stale. */
  headSha: string;
  stale: boolean;
  acknowledgedChecklistItems: string[];
  dismissedFindingCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Aggregate merge-readiness under the org's policy. */
export interface ReviewGateStatus {
  readyToMerge: boolean;
  requiredApprovals: number;
  currentApprovals: number;
  blockingReasons: string[];
  /** Advisory warnings that do not block. */
  warnings: string[];
  changesRequestedBy: Array<{ id: string; name: string }>;
}

// ---------------------------------------------------------------- comments

export const CreateCommentSchema = z.object({
  body: z.string().trim().min(1, 'Comment cannot be empty').max(20_000),
  /** Anchor to a specific line. Both required together for an inline comment. */
  path: z.string().max(500).optional(),
  line: z.number().int().min(1).optional(),
  /** Side of the diff the line refers to. */
  side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
  /** Reply target; creates a threaded response. */
  parentId: IdSchema.optional(),
  /** Links this comment to an AI or static finding. */
  findingFingerprint: z.string().max(128).optional(),
});
export type CreateCommentInput = z.infer<typeof CreateCommentSchema>;

export const UpdateCommentSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});

export interface CommentView {
  id: string;
  pullRequestId: string;
  author: { id: string; name: string; avatarUrl: string | null } | null;
  origin: CommentOrigin;
  body: string;
  path: string | null;
  line: number | null;
  side: 'LEFT' | 'RIGHT';
  parentId: string | null;
  replies: CommentView[];
  findingFingerprint: string | null;
  resolvedAt: string | null;
  resolvedBy: { id: string; name: string } | null;
  editedAt: string | null;
  createdAt: string;
  /** True when the anchored line no longer exists after a force-push. */
  outdated: boolean;
}

// ---------------------------------------------------------------- share links

export const CreateShareLinkSchema = z.object({
  scope: z.nativeEnum(ShareScope).default(ShareScope.SUMMARY),
  expiresInHours: z.number().int().min(1).max(24 * 90).default(168),
  /** Optional passphrase gate for anything beyond a summary. */
  passphrase: z.string().min(8).max(200).optional(),
  /** Hide file contents and diffs, leaving only the narrative review. */
  redactCode: z.boolean().default(false),
});
export type CreateShareLinkInput = z.infer<typeof CreateShareLinkSchema>;

export interface ShareLinkView {
  id: string;
  /** Full shareable URL. The raw token is never returned again after creation. */
  url: string;
  scope: ShareScope;
  redactCode: boolean;
  hasPassphrase: boolean;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
}

export const AccessShareLinkSchema = z.object({
  passphrase: z.string().max(200).optional(),
});

// ---------------------------------------------------------------- github publish

export const PostGithubCommentSchema = z.object({
  /** Include the file-by-file breakdown, not just the summary. */
  includeFileBreakdown: z.boolean().default(false),
  includeRiskScore: z.boolean().default(true),
  includeChecklist: z.boolean().default(true),
  /** Only publish findings at or above this severity. */
  minSeverity: z.nativeEnum(Severity).default(Severity.MEDIUM),
  categories: z.array(z.nativeEnum(FindingCategory)).default([]),
});
export type PostGithubCommentInput = z.infer<typeof PostGithubCommentSchema>;

export interface GithubPublishResult {
  commentId: number;
  htmlUrl: string;
  /** True when an existing CodeLens comment was updated rather than added. */
  updated: boolean;
  postedAt: string;
}
