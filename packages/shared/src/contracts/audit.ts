import { z } from 'zod';
import { AuditAction, FindingCategory, RiskLevel, Severity } from '../enums';
import { type JsonValue, PaginationQuerySchema } from './common';

// ---------------------------------------------------------------- audit log

export const ListAuditLogsQuerySchema = PaginationQuerySchema.extend({
  action: z.nativeEnum(AuditAction).optional(),
  actorUserId: z.string().optional(),
  resourceType: z.string().max(60).optional(),
  resourceId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().trim().max(200).optional(),
});
export type ListAuditLogsQuery = z.infer<typeof ListAuditLogsQuerySchema>;

export interface AuditLogView {
  id: string;
  action: AuditAction;
  /** Null for system-initiated events such as a scheduled re-index. */
  actor: { id: string; name: string; email: string } | null;
  actorType: 'USER' | 'SYSTEM' | 'WEBHOOK' | 'API_KEY';
  resourceType: string;
  resourceId: string | null;
  /** Human-readable summary rendered in the log table. */
  description: string;
  metadata: JsonValue;
  ipAddress: string | null;
  userAgent: string | null;
  traceId: string | null;
  createdAt: string;
}

export const ExportAuditLogsSchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  from: z.coerce.date(),
  to: z.coerce.date(),
});

// ---------------------------------------------------------------- analytics

export const AnalyticsRangeSchema = z.object({
  /** Inclusive window. Defaults to the last 30 days. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  repositoryId: z.string().optional(),
  teamId: z.string().optional(),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
});
export type AnalyticsRange = z.infer<typeof AnalyticsRangeSchema>;

export interface DashboardOverview {
  openPullRequests: number;
  pullRequestsAwaitingMyReview: number;
  highRiskOpenPullRequests: number;
  reviewRunsInProgress: number;
  reviewRunsLast7Days: number;
  medianReviewTimeMinutes: number | null;
  connectedRepositories: number;
  indexedRepositories: number;
  /** Findings surfaced in the window, by severity. */
  findingsBySeverity: Record<Severity, number>;
  riskDistribution: Record<RiskLevel, number>;
  aiSpendCentsThisMonth: number;
}

export interface RiskTrendPoint {
  /** ISO date at the start of the bucket. */
  bucket: string;
  pullRequestCount: number;
  averageRiskScore: number;
  highRiskCount: number;
  criticalFindingCount: number;
}

export interface RiskyFileEntry {
  path: string;
  repositoryId: string;
  repositoryFullName: string;
  /** Times this file appeared in a PR during the window. */
  changeCount: number;
  findingCount: number;
  criticalFindingCount: number;
  changesRequestedCount: number;
  averageRiskScoreOfContainingPrs: number;
  /** Composite hotspot score: change frequency weighted by findings. */
  hotspotScore: number;
}

export interface IssueCategoryEntry {
  category: FindingCategory;
  count: number;
  /** Share of all findings in the window. */
  share: number;
  /** Change vs the previous equivalent window, as a ratio. */
  trend: number | null;
  topRules: Array<{ ruleId: string; count: number }>;
}

/**
 * Recurring mistake patterns per developer.
 *
 * Framed as coaching signal, not a leaderboard: the response deliberately has no
 * ranking field, and the UI presents it to the developer themselves plus their
 * lead rather than org-wide.
 */
export interface DeveloperPatternEntry {
  userId: string | null;
  githubLogin: string;
  name: string;
  pullRequestCount: number;
  averageRiskScore: number;
  changesRequestedRate: number;
  testCoverageRate: number;
  /** Their most frequent finding categories, for targeted feedback. */
  recurringCategories: Array<{ category: FindingCategory; count: number }>;
  mostFrequentRules: Array<{ ruleId: string; count: number; description: string }>;
  improvementTrend: number | null;
}

export interface ReviewTimeAnalytics {
  medianMinutes: number | null;
  p90Minutes: number | null;
  averageMinutes: number | null;
  /** Predicted vs actual, to show whether the regression model is trustworthy. */
  predictionAccuracy: {
    meanAbsoluteErrorMinutes: number;
    samplesCompared: number;
  } | null;
  byRiskLevel: Record<RiskLevel, number | null>;
  buckets: Array<{ bucket: string; medianMinutes: number | null; count: number }>;
}

export interface AnalyticsResponse {
  range: { from: string; to: string; granularity: string };
  riskTrend: RiskTrendPoint[];
  riskyFiles: RiskyFileEntry[];
  issueCategories: IssueCategoryEntry[];
  developerPatterns: DeveloperPatternEntry[];
  reviewTime: ReviewTimeAnalytics;
}
