export {
  GithubClient,
  type GithubClientOptions,
  type PullRequestFileWithDiff,
  type RateLimitInfo,
  type RawPullRequest,
} from './client';
export {
  EXACT_GIT_LIMITS,
  validateExactGitPath,
  type ExactGitFile,
  type GitEntryKind,
} from './exact-git-file';
export {
  materializeExactSnapshot,
  snapshotDigest,
  SNAPSHOT_LIMITS,
  type ExactSnapshot,
  type ExactSnapshotFile,
} from './exact-git-snapshot';

export {
  addedLines,
  buildTouchedLineMap,
  extractIdentifiers,
  extractImportSpecifiers,
  formatHunksForPrompt,
  mapFileStatus,
  parseFileDiff,
  parseUnifiedPatch,
  reconstructSides,
  removedLines,
  touchedLineNumbers,
  type AddedLine,
  type RawGithubFile,
  type ReconstructedLine,
  type ReconstructedSides,
} from './diff-parser';

export {
  GithubError,
  classifyGithubError,
  type GithubErrorKind,
} from './errors';

export {
  assessScopes,
  buildAuthorizeUrl,
  createOAuthState,
  exchangeCodeForToken,
  verifyOAuthState,
  verifyWebhookSignature,
  type GithubOAuthConfig,
  type GithubTokenResponse,
  type VerifiedOAuthState,
} from './oauth';
