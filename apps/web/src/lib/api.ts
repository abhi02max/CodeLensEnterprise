import { apiRequest, setAccessToken } from './api-client';
import type {
  ConversationDetail,
  ConversationList,
  ConversationView,
  CreateConversationInput,
  CreateConversationMessageInput,
  CreateConversationMessageResponse,
  InvestigationResult,
  InvestigationTool,
  EvidenceView,
  CollaborationExecutionView,
  PatchProposalView,
  PatchIntent,
  PatchProposalList,
  PatchApplicationView,
  PatchApplicationList,
  PatchApplicationRequest,
  ValidationView,
  ValidationRequest,
  ValidationStaticView,
  StaticFindingsQuery,
  ValidationMlView,
} from '@codelens/shared';
import type {
  AuditLogView,
  AuthResponse,
  CommentView,
  HealthResponse,
  JobStatus,
  OpenSessionResponse,
  OrganizationView,
  Paginated,
  PullRequestListItem,
  RepositoryView,
  ReviewGateStatus,
  ReviewSession,
  ReviewView,
  SessionResponse,
  SharedReview,
  ShareLinkView,
} from './types';

/**
 * Typed endpoint functions.
 *
 * One function per API operation, so a URL or payload shape is written once. Every list endpoint
 * returns the API's `Paginated<T>` envelope unchanged rather than being flattened to an array —
 * the totals drive the dashboard counts, and unwrapping them here would mean fetching twice.
 */
export const api = {
  validationMl: (id: string) =>
    apiRequest<ValidationMlView | null>(`/validations/${encodeURIComponent(id)}/ml-assessment`),
  requestValidationMl: (id: string, requestId: string) =>
    apiRequest<ValidationMlView>(`/validations/${encodeURIComponent(id)}/ml-assessment`, {
      method: 'POST',
      body: { requestId },
    }),
  cancelValidationMl: (id: string, comparisonId: string, requestId: string) =>
    apiRequest<ValidationMlView>(
      `/validations/${encodeURIComponent(id)}/ml-assessment/${encodeURIComponent(comparisonId)}/cancel`,
      { method: 'POST', body: { requestId } },
    ),
  validations: (applicationId: string, afterId?: string) =>
    apiRequest<{ items: ValidationView[]; nextAfterId: string | null }>(
      `/patch-applications/${encodeURIComponent(applicationId)}/validations${afterId ? `?afterId=${encodeURIComponent(afterId)}` : ''}`,
    ),
  validation: (id: string) => apiRequest<ValidationView>(`/validations/${encodeURIComponent(id)}`),
  validationStatic: (id: string, query: Partial<StaticFindingsQuery> = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    return apiRequest<ValidationStaticView>(
      `/validations/${encodeURIComponent(id)}/static-findings?${params}`,
    );
  },
  requestValidation: (id: string, input: ValidationRequest) =>
    apiRequest<ValidationView>(`/patch-applications/${encodeURIComponent(id)}/validations`, {
      method: 'POST',
      body: input,
    }),
  cancelValidation: (id: string, requestId: string) =>
    apiRequest<ValidationView>(`/validations/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: { requestId },
    }),
  // ---------------------------------------------------------------- auth
  async signIn(email: string, password: string): Promise<AuthResponse> {
    const response = await apiRequest<AuthResponse>('/auth/signin', {
      method: 'POST',
      body: { email, password },
      authenticated: false,
    });

    setAccessToken(response.tokens.accessToken);
    return response;
  },

  session: () => apiRequest<SessionResponse>('/auth/session'),

  async signOut(): Promise<void> {
    // Best effort: clearing the local token matters more than the server acknowledging it, so a
    // failure here must not leave the user stuck on a screen they are trying to leave.
    try {
      await apiRequest<void>('/auth/signout', { method: 'POST' });
    } finally {
      setAccessToken(null);
    }
  },

  // ---------------------------------------------------------------- org + health
  organization: () => apiRequest<OrganizationView>('/organizations/current'),

  health: () => apiRequest<HealthResponse>('/health', { authenticated: false }),

  // ---------------------------------------------------------------- repositories
  repositories: (page = 1, pageSize = 50) =>
    apiRequest<Paginated<RepositoryView>>(`/repositories?page=${page}&pageSize=${pageSize}`),

  repository: (id: string) => apiRequest<RepositoryView>(`/repositories/${id}`),

  /** Queues an organization-wide sync and returns the job to poll. */
  syncRepositories: () =>
    apiRequest<{ mode: 'queued'; job: JobStatus; pollUrl: string }>('/repositories/sync', {
      method: 'POST',
      body: {},
    }),

  // ---------------------------------------------------------------- pull requests
  pullRequests: (params: { repositoryId?: string; page?: number; pageSize?: number } = {}) => {
    const query = new URLSearchParams({
      page: String(params.page ?? 1),
      pageSize: String(params.pageSize ?? 50),
      ...(params.repositoryId ? { repositoryId: params.repositoryId } : {}),
    });

    return apiRequest<Paginated<PullRequestListItem>>(`/pull-requests?${query.toString()}`);
  },

  /**
   * Trigger analysis. Queued by default, so this returns a job rather than a result.
   *
   * `force` is passed because the only reason to press Analyze on an already-analysed pull
   * request is to get a fresh answer; without it the API would hand back the cached run and the
   * button would look broken.
   */
  analyze: (pullRequestId: string, force = true) =>
    apiRequest<{
      mode: 'queued' | 'sync';
      job: JobStatus | null;
      pollUrl?: string;
      reused: boolean;
    }>(`/pull-requests/${pullRequestId}/analyze`, {
      method: 'POST',
      body: { force, postToGithub: false },
    }),

  job: (handle: string) => apiRequest<JobStatus>(`/jobs/${encodeURIComponent(handle)}`),

  // ---------------------------------------------------------------- review session
  openSession: (pullRequestId: string, analyzeIfStale = false) =>
    apiRequest<OpenSessionResponse>('/review-sessions', {
      method: 'POST',
      body: { pullRequestId, analyzeIfStale },
    }),

  session_: (id: string) => apiRequest<ReviewSession>(`/review-sessions/${id}`),

  conversations: (prId: string, afterId?: string) =>
    apiRequest<ConversationList>(
      `/review-sessions/${encodeURIComponent(prId)}/conversations${afterId ? `?afterId=${encodeURIComponent(afterId)}` : ''}`,
    ),
  patchProposals: (conversationId: string, afterId?: string) =>
    apiRequest<PatchProposalList>(
      `/conversations/${encodeURIComponent(conversationId)}/patch-proposals${afterId ? `?afterId=${encodeURIComponent(afterId)}` : ''}`,
    ),
  patchDecision: (id: string, requestId: string, decision: 'ACCEPTED' | 'REJECTED') =>
    apiRequest<PatchProposalView>(`/patch-proposals/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      body: { requestId, decision },
    }),
  patchApplications: (id: string, afterId?: string) =>
    apiRequest<PatchApplicationList>(
      `/patch-proposals/${encodeURIComponent(id)}/applications${afterId ? `?afterId=${encodeURIComponent(afterId)}` : ''}`,
    ),
  requestPatchApplication: (id: string, input: PatchApplicationRequest) =>
    apiRequest<PatchApplicationView>(`/patch-proposals/${encodeURIComponent(id)}/applications`, {
      method: 'POST',
      body: input,
    }),
  cancelPatchApplication: (id: string, requestId: string) =>
    apiRequest<PatchApplicationView>(`/patch-applications/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: { requestId },
    }),
  patchRevision: (id: string, requestId: string, proposal: PatchIntent) =>
    apiRequest<PatchProposalView>(`/patch-proposals/${encodeURIComponent(id)}/revisions`, {
      method: 'POST',
      body: { requestId, proposal },
    }),
  patchFeedback: (id: string, requestId: string, content: string) =>
    apiRequest<CreateConversationMessageResponse>(
      `/patch-proposals/${encodeURIComponent(id)}/revision-request`,
      { method: 'POST', body: { requestId, content } },
    ),
  investigate: (turnId: string, tool: InvestigationTool, requestId: string, input: unknown) =>
    apiRequest<InvestigationResult>(
      `/collaboration-turns/${encodeURIComponent(turnId)}/tools/${tool}`,
      {
        method: 'POST',
        body: { requestId, input },
      },
    ),
  investigations: (turnId: string) =>
    apiRequest<{ items: InvestigationResult[]; nextAfterSequence: number | null }>(
      `/collaboration-turns/${encodeURIComponent(turnId)}/evidence`,
    ),
  investigation: (id: string) =>
    apiRequest<InvestigationResult>(`/collaboration-tools/${encodeURIComponent(id)}`),
  evidence: (id: string) =>
    apiRequest<EvidenceView>(`/evidence-references/${encodeURIComponent(id)}`),
  collaborationTurn: (id: string) =>
    apiRequest<CollaborationExecutionView>(`/collaboration-turns/${encodeURIComponent(id)}`),
  cancelCollaboration: (id: string) =>
    apiRequest<CollaborationExecutionView>(
      `/collaboration-turns/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', body: {} },
    ),
  retryCollaboration: (id: string, attempt: number) =>
    apiRequest<CollaborationExecutionView>(`/collaboration-turns/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      body: { attempt },
    }),
  createConversation: (prId: string, input: CreateConversationInput) =>
    apiRequest<ConversationView>(`/review-sessions/${encodeURIComponent(prId)}/conversations`, {
      method: 'POST',
      body: input,
    }),
  conversation: (id: string, afterSequence = 0) =>
    apiRequest<ConversationDetail>(
      `/conversations/${encodeURIComponent(id)}?afterSequence=${afterSequence}`,
    ),
  createConversationMessage: (id: string, input: CreateConversationMessageInput) =>
    apiRequest<CreateConversationMessageResponse>(
      `/conversations/${encodeURIComponent(id)}/messages`,
      { method: 'POST', body: input },
    ),

  approve: (id: string, summary?: string) =>
    apiRequest<{ review: ReviewView; gate: ReviewGateStatus }>(`/review-sessions/${id}/approve`, {
      method: 'POST',
      body: summary ? { summary } : {},
    }),

  requestChanges: (id: string, summary?: string) =>
    apiRequest<{ review: ReviewView; gate: ReviewGateStatus }>(
      `/review-sessions/${id}/request-changes`,
      { method: 'POST', body: summary ? { summary } : {} },
    ),

  // ---------------------------------------------------------------- comments
  comments: (sessionId: string) =>
    apiRequest<CommentView[]>(`/review-sessions/${sessionId}/comments`),

  createComment: (
    sessionId: string,
    input: {
      body: string;
      path?: string;
      line?: number;
      parentId?: string;
      findingFingerprint?: string;
    },
  ) =>
    apiRequest<CommentView>(`/review-sessions/${sessionId}/comments`, {
      method: 'POST',
      body: input,
    }),

  resolveComment: (commentId: string) =>
    apiRequest<CommentView>(`/comments/${commentId}/resolve`, { method: 'POST' }),

  reopenComment: (commentId: string) =>
    apiRequest<CommentView>(`/comments/${commentId}/reopen`, { method: 'POST' }),

  deleteComment: (commentId: string) =>
    apiRequest<void>(`/comments/${commentId}`, { method: 'DELETE' }),

  // ---------------------------------------------------------------- share links
  createShareLink: (
    sessionId: string,
    input: {
      scope: 'SUMMARY' | 'FULL';
      expiresInHours: number;
      redactCode: boolean;
      passphrase?: string;
    },
  ) =>
    apiRequest<ShareLinkView & { token: string }>(`/review-sessions/${sessionId}/share-link`, {
      method: 'POST',
      body: input,
    }),

  revokeShareLink: (sessionId: string, shareLinkId: string) =>
    apiRequest<ShareLinkView>(`/review-sessions/${sessionId}/share-link/${shareLinkId}`, {
      method: 'DELETE',
    }),

  /**
   * Read a shared review without authentication.
   *
   * `authenticated: false` matters here beyond skipping the header: it stops a 401 from a
   * passphrase prompt being mistaken for an expired session and triggering a refresh, which would
   * log a signed-in viewer out for opening a protected link.
   */
  sharedReview: (token: string, passphrase?: string) =>
    apiRequest<SharedReview>(`/review-sessions/share/${encodeURIComponent(token)}`, {
      authenticated: false,
      ...(passphrase ? { headers: { 'X-Share-Passphrase': passphrase } } : {}),
    }),

  // ---------------------------------------------------------------- audit
  auditLogs: (params: { page?: number; pageSize?: number; resourceId?: string } = {}) => {
    const query = new URLSearchParams({
      page: String(params.page ?? 1),
      pageSize: String(params.pageSize ?? 20),
      ...(params.resourceId ? { resourceId: params.resourceId } : {}),
    });

    return apiRequest<Paginated<AuditLogView>>(`/audit-logs?${query.toString()}`);
  },
};
