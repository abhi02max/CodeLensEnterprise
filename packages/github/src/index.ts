export {
  GithubClient,
  type GithubClientOptions,
  type PullRequestFileWithDiff,
  type RateLimitInfo,
  type RawPullRequest,
} from './client';

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
