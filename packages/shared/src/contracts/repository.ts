import { z } from 'zod';
import {
  FileChangeStatus,
  FileFlag,
  IndexStatus,
  PullRequestState,
  RiskLevel,
} from '../enums';
import { IdSchema, PaginationQuerySchema } from './common';

// ---------------------------------------------------------------- repositories

export const ConnectRepositorySchema = z.object({
  /** GitHub numeric id; stable across renames, unlike fullName. */
  githubId: z.number().int().positive(),
  fullName: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'Expected "owner/repo"')
    .max(200),
  /** Queue an index immediately after connecting. */
  autoIndex: z.boolean().default(true),
  teamIds: z.array(IdSchema).max(20).default([]),
});
export type ConnectRepositoryInput = z.infer<typeof ConnectRepositorySchema>;

export const ListRepositoriesQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().max(200).optional(),
  /** Only repos already connected to CodeLens. */
  connectedOnly: z.coerce.boolean().default(false),
});

/** A repo on GitHub the user can see but may not have connected yet. */
export interface GithubRepositoryOption {
  githubId: number;
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  stargazersCount: number;
  updatedAt: string;
  permissions: { admin: boolean; push: boolean; pull: boolean };
  connected: boolean;
}

export interface RepositoryView {
  id: string;
  githubId: number;
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  primaryLanguage: string | null;
  indexStatus: IndexStatus;
  indexedAt: string | null;
  indexedChunkCount: number;
  /** Set when indexStatus is FAILED. */
  indexError: string | null;
  openPullRequestCount: number;
  lastSyncedAt: string | null;
  connectedAt: string;
  teams: Array<{ id: string; name: string }>;
}

export const ReindexRepositorySchema = z.object({
  /** Re-embed everything instead of only changed files. */
  force: z.boolean().default(false),
});

// ---------------------------------------------------------------- pull requests

export const PullRequestStateSchema = z.nativeEnum(PullRequestState);

export const ListPullRequestsQuerySchema = PaginationQuerySchema.extend({
  repositoryId: IdSchema.optional(),
  state: PullRequestStateSchema.optional(),
  authorLogin: z.string().max(120).optional(),
  riskLevel: z.nativeEnum(RiskLevel).optional(),
  search: z.string().trim().max(200).optional(),
  /** Only PRs with at least one completed review run. */
  analyzedOnly: z.coerce.boolean().default(false),
  sortBy: z.enum(['updatedAt', 'createdAt', 'riskScore', 'additions']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});
export type ListPullRequestsQuery = z.infer<typeof ListPullRequestsQuerySchema>;

export interface PullRequestAuthor {
  login: string;
  avatarUrl: string | null;
  /** Populated when the GitHub account maps to a CodeLens user. */
  userId: string | null;
}

export interface PullRequestListItem {
  id: string;
  repository: { id: string; fullName: string };
  number: number;
  title: string;
  state: PullRequestState;
  author: PullRequestAuthor;
  headRef: string;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  draft: boolean;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  /** Null until a review run completes. */
  risk: {
    score: number;
    level: RiskLevel;
    modelVersion: string;
  } | null;
  latestRun: {
    id: string;
    status: string;
    stage: string;
    finishedAt: string | null;
  } | null;
  humanReviewSummary: {
    approvals: number;
    changesRequested: number;
    needsDiscussion: number;
  };
  unresolvedCommentCount: number;
  flags: FileFlag[];
}

export interface PullRequestDetail extends PullRequestListItem {
  body: string | null;
  repository: { id: string; fullName: string; defaultBranch: string };
  mergeable: boolean | null;
  merged: boolean;
  mergedAt: string | null;
  headSha: string;
  baseSha: string;
  labels: string[];
  files: PullRequestFileView[];
  commits: CommitView[];
  diffRevision: PullRequestDiffRevision;
}

export interface PullRequestDiffRevision {
  provenance: 'VERIFIED' | 'UNVERIFIED';
  baseSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  fileSet: 'COMPLETE' | 'PARTIAL' | 'UNVERIFIED';
  patches: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE' | 'UNVERIFIED';
}

export interface PullRequestFilesView {
  pullRequestId: string;
  baseSha: string;
  headSha: string;
  diffRevision: PullRequestDiffRevision;
  files: PullRequestFileView[];
}

export interface PullRequestFileView {
  id: string;
  filename: string;
  previousFilename: string | null;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  changes: number;
  language: string;
  flags: FileFlag[];
  /** Bounded unified hunks; null may mean remote omission or local policy omission. */
  patch: string | null;
  /** True when only a locally bounded prefix was retained. */
  patchTruncated: boolean;
  /** Legacy compatibility flag; false does not establish that content is text. */
  binary: boolean;
  /** Static findings attached to this file in the latest run. */
  findingCount: number;
  patchAvailability: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE' | 'UNVERIFIED';
}

export interface CommitView {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorLogin: string | null;
  authoredAt: string;
  additions: number | null;
  deletions: number | null;
}

export const SyncPullRequestsSchema = z.object({
  state: z.enum(['open', 'closed', 'all']).default('open'),
  limit: z.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------- diff parsing

/** One contiguous hunk of a unified diff. */
export interface DiffHunk {
  /** Raw header, e.g. "@@ -14,7 +14,9 @@ function foo() {". */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'del' | 'context';
  /** Line number in the new file; null for deletions. */
  newLineNumber: number | null;
  /** Line number in the old file; null for additions. */
  oldLineNumber: number | null;
  content: string;
}

export interface ParsedFileDiff {
  filename: string;
  previousFilename: string | null;
  status: FileChangeStatus;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * Line numbers a PR actually touched, per file. Used to scope static findings so
 * pre-existing issues do not count against the author.
 */
export type TouchedLineMap = Map<string, Set<number>>;
