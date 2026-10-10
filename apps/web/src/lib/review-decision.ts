import type { ReviewSession, ReviewView, ShareLinkView } from './types';
import { ApiError } from './api-client';

export const verdictLabels = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  NEEDS_DISCUSSION: 'Needs discussion',
} as const;
export type WritableVerdict = 'APPROVED' | 'CHANGES_REQUESTED';

export function decisionReady(
  session: ReviewSession,
  target: { id: string; repositoryId: string; headSha: string } | undefined,
  reviewedHead: string,
): boolean {
  return (
    !!target &&
    session.sessionId === session.pullRequestId &&
    session.pullRequest.id === session.pullRequestId &&
    target.id === session.pullRequestId &&
    target.repositoryId === session.repository.id &&
    /^[a-f0-9]{40}$/.test(reviewedHead) &&
    target.headSha === reviewedHead &&
    session.pullRequest.headSha === reviewedHead &&
    !session.pullRequest.merged
  );
}

export function canDecide(session: ReviewSession, verdict: WritableVerdict): boolean {
  return verdict === 'APPROVED'
    ? session.permissions.canApprove
    : session.permissions.canRequestChanges;
}

export function currentAnalysis(session: ReviewSession): boolean {
  return (
    session.analyzed &&
    /^[a-f0-9]{40}$/.test(session.pullRequest.headSha) &&
    session.run?.status === 'COMPLETED' &&
    !session.run.stale &&
    session.run.headSha === session.pullRequest.headSha
  );
}

export function currentVerdict(review: ReviewView, session: ReviewSession): boolean {
  return (
    !review.stale &&
    /^[a-f0-9]{40}$/.test(review.headSha) &&
    review.headSha === session.pullRequest.headSha &&
    (!review.pullRequestId || review.pullRequestId === session.pullRequestId)
  );
}

export function safeActionError(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return `${action} conflicted with the recorded state. Refresh and review it before trying again.`;
    if (error.status === 401) return 'Your session is unavailable. Sign in again.';
    if (error.status === 403) return `You are not authorized to ${action.toLowerCase()}.`;
    if (error.status === 404) return 'This review or record is unavailable.';
    if (error.status === 400 || error.status === 422)
      return `${action} was rejected. Check the entered values.`;
  }
  return `${action} could not be confirmed. Refresh the readback before deciding whether to try again.`;
}

/** Synchronous fencing covers multiple activations before React renders pending state. */
export function actionFence() {
  let busy = false;
  return {
    acquire() {
      if (busy) return false;
      busy = true;
      return true;
    },
    release() {
      busy = false;
    },
    get busy() {
      return busy;
    },
  };
}

export function shareStatus(link: ShareLinkView, now: number): string {
  if (link.revokedAt) return 'Revoked';
  const expiry = new Date(link.expiresAt).getTime();
  if (!Number.isFinite(expiry)) return 'Expiry unavailable';
  return expiry <= now
    ? 'Past recorded expiry (local clock)'
    : 'Not revoked; within recorded expiry (local clock)';
}

export function shareInputValid(passphrase: string, hours: number): boolean {
  const length = passphrase.trim().length;
  return (
    (!length || (length >= 8 && length <= 200)) &&
    Number.isInteger(hours) &&
    hours >= 1 &&
    hours <= 2160
  );
}
