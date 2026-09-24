import { Role, roleAtLeast } from '@codelens/shared';

/**
 * What the current viewer may do in a review session.
 *
 * Returned with the workspace so the UI can disable actions instead of offering buttons that
 * fail, and computed from one function so the client's view of the rules and the server's
 * enforcement of them cannot drift. Every field here has a matching server-side check; this is
 * an affordance, never the authorization itself.
 */
export interface ReviewPermissions {
  canComment: boolean;
  canApprove: boolean;
  canRequestChanges: boolean;
  /** Resolve or reopen a thread someone else started. */
  canModerateComments: boolean;
  canCreateShareLink: boolean;
  canRevokeShareLink: boolean;
  canTriggerAnalysis: boolean;
  canPostToGithub: boolean;
  /**
   * Populated when an action is denied for a reason the role alone does not explain, so the
   * UI can say why rather than showing a dead button.
   */
  deniedReasons: Record<string, string>;
}

export interface PermissionContext {
  role: Role;
  userId: string;
  /** Resolved CodeLens user for the PR author, when the GitHub login is linked. */
  pullRequestAuthorUserId: string | null;
  /** From the organization's review policy. */
  githubCommentMinRole: Role;
}

/**
 * Self-approval is refused.
 *
 * Not a role question — an author can hold any role — so it cannot live in the guard. The
 * reason it matters: an approval is a claim that someone other than the author checked the
 * change, and a self-approval that satisfies `minApprovals` would let the gate report
 * "ready to merge" with nobody having reviewed it. Requesting changes on your own PR is
 * allowed, since that only ever withholds the gate.
 */
export function computePermissions(ctx: PermissionContext): ReviewPermissions {
  const isAuthor =
    ctx.pullRequestAuthorUserId !== null && ctx.pullRequestAuthorUserId === ctx.userId;

  const isReviewer = roleAtLeast(ctx.role, Role.REVIEWER);
  const isAdmin = roleAtLeast(ctx.role, Role.ADMIN);

  const deniedReasons: Record<string, string> = {};

  if (!isReviewer) {
    deniedReasons.canApprove = `Approving requires the REVIEWER role or higher; your role is ${ctx.role}.`;
    deniedReasons.canRequestChanges = deniedReasons.canApprove;
  } else if (isAuthor) {
    deniedReasons.canApprove =
      'You opened this pull request. An approval has to come from someone else for the ' +
      'merge gate to mean anything.';
  }

  if (!isAdmin) {
    deniedReasons.canCreateShareLink = `Sharing a review externally requires the ADMIN role or higher; your role is ${ctx.role}.`;
    deniedReasons.canRevokeShareLink = deniedReasons.canCreateShareLink;
  }

  if (!roleAtLeast(ctx.role, ctx.githubCommentMinRole)) {
    deniedReasons.canPostToGithub =
      `Posting a review to GitHub requires the ${ctx.githubCommentMinRole} role or higher ` +
      `under this organization's policy; your role is ${ctx.role}.`;
  }

  return {
    canComment: roleAtLeast(ctx.role, Role.DEVELOPER),
    canApprove: isReviewer && !isAuthor,
    canRequestChanges: isReviewer,
    canModerateComments: isReviewer,
    canCreateShareLink: isAdmin,
    canRevokeShareLink: isAdmin,
    canTriggerAnalysis: roleAtLeast(ctx.role, Role.DEVELOPER),
    canPostToGithub: roleAtLeast(ctx.role, ctx.githubCommentMinRole),
    deniedReasons,
  };
}
