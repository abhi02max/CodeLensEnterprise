import { z } from 'zod';
import { AiProvider, Role, Severity } from '../enums';
import { EmailSchema } from './auth';
import { IdSchema } from './common';

export const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Use lowercase letters, numbers and hyphens');

export const CreateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: SlugSchema.optional(),
});
export type CreateOrganizationInput = z.infer<typeof CreateOrganizationSchema>;

export const UpdateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
});

// ---------------------------------------------------------------- membership

export const RoleSchema = z.nativeEnum(Role);

export const InviteMemberSchema = z.object({
  email: EmailSchema,
  /** OWNER cannot be granted by invite; ownership transfer is a separate flow. */
  role: z.enum([Role.DEVELOPER, Role.REVIEWER, Role.ADMIN]),
  teamIds: z.array(IdSchema).max(20).default([]),
});
export type InviteMemberInput = z.infer<typeof InviteMemberSchema>;

export const UpdateMemberRoleSchema = z.object({
  role: z.enum([Role.DEVELOPER, Role.REVIEWER, Role.ADMIN]),
});

export interface MemberView {
  id: string;
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: Role;
  teams: Array<{ id: string; name: string }>;
  joinedAt: string;
  lastActiveAt: string | null;
  /** Review throughput, useful for spotting an overloaded reviewer. */
  stats: {
    reviewsSubmitted: number;
    pullRequestsAuthored: number;
    openAssignedReviews: number;
  };
}

export interface PendingInviteView {
  id: string;
  email: string;
  role: Role;
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
}

// ---------------------------------------------------------------- teams

export const CreateTeamSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  memberIds: z.array(IdSchema).max(200).default([]),
});
export type CreateTeamInput = z.infer<typeof CreateTeamSchema>;

export const UpdateTeamSchema = CreateTeamSchema.partial();

export interface TeamView {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  repositoryCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------- review policy

/**
 * Per-organization governance. This is what makes the platform usable by a team
 * with opinions: the AI's severity thresholds, approval requirements and GitHub
 * write permissions are all configuration, not hardcoded behaviour.
 */
export const ReviewPolicySchema = z.object({
  blockingSeverity: z.nativeEnum(Severity),
  riskScoreGate: z.number().int().min(0).max(100),
  requireTestsForCodeChanges: z.boolean(),
  minApprovals: z.number().int().min(0).max(10),
  sensitiveFlagsRequireTwoApprovals: z.boolean(),
  autoPostGithubComment: z.boolean(),
  blockOnSecretDetection: z.boolean(),
  githubCommentMinRole: RoleSchema,
  /** Reviewer checklist items appended to every generated review. */
  checklist: z.array(z.string().trim().min(3).max(300)).max(40),
  /** Extra Semgrep rulesets, e.g. "p/react" or a path under infra/semgrep. */
  extraSemgrepRulesets: z.array(z.string().max(200)).max(20).default([]),
  /** Glob patterns excluded from analysis and indexing. */
  excludePatterns: z.array(z.string().max(200)).max(100).default([]),
});
export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;

export const UpdateReviewPolicySchema = ReviewPolicySchema.partial();

// ---------------------------------------------------------------- ai settings

export const AiSettingsSchema = z.object({
  provider: z.nativeEnum(AiProvider),
  model: z.string().min(1).max(120),
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().min(256).max(32_000),
  maxCostCentsPerRun: z.number().int().min(1).max(10_000),
  /**
   * When false, diffs are never sent to a third-party provider and the review
   * falls back to static analysis plus ML only. Some orgs need this to adopt
   * the product at all.
   */
  allowExternalModelCalls: z.boolean(),
  /** Redact detected secrets before any provider call. Strongly recommended. */
  redactSecretsBeforeSend: z.boolean(),
  embeddingProvider: z.enum(['openai', 'local', 'gemini']),
  embeddingModel: z.string().min(1).max(120),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

export const UpdateAiSettingsSchema = AiSettingsSchema.partial();

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  plan: string;
  memberCount: number;
  repositoryCount: number;
  createdAt: string;
  myRole: Role;
}

// ---------------------------------------------------------------- api keys

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** Null means no expiry; the UI warns about this. */
  expiresInDays: z.number().int().min(1).max(730).nullable().default(90),
});

export interface ApiKeyView {
  id: string;
  name: string;
  /** First 8 chars only; the full key is shown exactly once at creation. */
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
