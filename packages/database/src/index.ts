export {
  prisma,
  createPrismaClient,
  forOrganization,
  classifyDatabaseError,
  TenantScopeViolationError,
  TENANT_SCOPED_MODELS,
  type ScopedPrismaClient,
  type PrismaTransactionClient,
  type DatabaseErrorKind,
  type ClassifiedDatabaseError,
} from './client';

export {
  retuneVectorIndex,
  EMBEDDING_DIMENSIONS,
} from './vector-setup';

export {
  BASELINE_MIGRATION,
  EXPECTED_TABLES,
  criticalSchemaIssues,
  decideInitialization,
  readDatabaseSnapshot,
  type DatabaseSnapshot,
  type InitializationState,
} from './schema-compatibility';

// Re-export the generated types so consumers depend on @codelens/database rather
// than reaching into @prisma/client directly. Keeps the ORM swappable in theory
// and, more usefully, keeps imports consistent across the codebase.
export { Prisma, PrismaClient } from '@prisma/client';
export type {
  Account,
  AiReview,
  AiSettings,
  ApiKey,
  AuditLog,
  Comment,
  Commit,
  DismissedFinding,
  IndexRun,
  Invite,
  Membership,
  MlPrediction,
  Organization,
  PrMetrics,
  PullRequest,
  PullRequestFile,
  RagChunk,
  Repository,
  RepositoryTeam,
  RetrievedContext,
  Review,
  ReviewPolicy,
  ReviewRun,
  ShareLink,
  StaticFinding,
  Team,
  TeamMember,
  ToolRun,
  User,
} from '@prisma/client';

export {
  ActorType,
  AiProviderKind,
  AnalyzerKind,
  ApprovalRecommendation,
  ChunkKind,
  CommentOrigin,
  FileChangeStatus,
  FindingCategory,
  IndexStatus,
  MlStatus,
  PullRequestState,
  ReviewRunStatus,
  ReviewStage,
  ReviewVerdict,
  RiskLevel,
  Role,
  RunTrigger,
  Severity,
  ShareScope,
  ToolRunStatus,
} from '@prisma/client';
