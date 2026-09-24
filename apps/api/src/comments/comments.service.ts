import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  CommentOrigin,
  Role,
  roleAtLeast,
  type CommentView,
  type CreateCommentInput,
} from '@codelens/shared';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit-logs/audit.service';

interface ActorContext {
  organizationId: string;
  userId: string;
  role: Role;
  traceId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Review discussion threads.
 *
 * Comments hang off the pull request rather than off a `ReviewRun`, which is the right anchor
 * for a reason worth stating: a conversation about a line of code outlives the analysis run
 * that first surfaced the issue. Anchoring to the run would orphan every thread the moment
 * someone re-triggered analysis, which is exactly when people are most likely to be mid-
 * discussion.
 *
 * Three levels of anchoring, all optional and increasingly specific:
 *   - the pull request, for general discussion
 *   - a file and line, for inline review comments
 *   - a finding fingerprint, which links the thread to a specific static or AI finding so
 *     resolving it feeds the merge gate
 *
 * The fingerprint link is what makes the gate more than a severity count: a HIGH finding with
 * a resolved thread stops blocking the merge, because a human looked at it and said something.
 */
@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    actor: ActorContext,
    pullRequestId: string,
    input: CreateCommentInput,
  ): Promise<CommentView> {
    const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
      where: { id: pullRequestId, organizationId: actor.organizationId },
      select: {
        id: true,
        number: true,
        merged: true,
        repository: { select: { fullName: true } },
      },
    });

    if (!pullRequest) throw new NotFoundError('Review session', pullRequestId);

    // path and line are meaningless apart. A line without a file cannot be rendered, and a file
    // without a line is indistinguishable from a general comment while looking like an inline
    // one in the API.
    if ((input.path === undefined) !== (input.line === undefined)) {
      throw new ValidationError(
        'An inline comment needs both path and line. Omit both for a general comment on the ' +
          'pull request.',
        {
          ...(input.path === undefined ? { path: ['Required when line is given'] } : {}),
          ...(input.line === undefined ? { line: ['Required when path is given'] } : {}),
        },
      );
    }

    if (input.path !== undefined) {
      await this.assertPathIsInDiff(pullRequestId, input.path);
    }

    const parent = input.parentId
      ? await this.resolveParent(actor.organizationId, pullRequestId, input.parentId)
      : null;

    if (input.findingFingerprint) {
      await this.assertFingerprintExists(
        actor.organizationId,
        pullRequestId,
        input.findingFingerprint,
      );
    }

    const row = await this.prisma.unscoped.comment.create({
      data: {
        organizationId: actor.organizationId,
        pullRequestId,
        authorId: actor.userId,
        origin: CommentOrigin.HUMAN,
        body: input.body,
        // A reply inherits its parent's anchor. Letting a reply point somewhere else would
        // produce a thread whose messages render in different places.
        path: parent ? parent.path : (input.path ?? null),
        line: parent ? parent.line : (input.line ?? null),
        side: parent ? parent.side : input.side,
        parentId: parent?.id ?? null,
        findingFingerprint: parent
          ? parent.findingFingerprint
          : (input.findingFingerprint ?? null),
      },
      include: COMMENT_INCLUDE,
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      action: AuditAction.COMMENT_CREATED,
      actorId: actor.userId,
      resourceType: 'Comment',
      resourceId: row.id,
      description:
        `Commented on ${pullRequest.repository.fullName}#${pullRequest.number}` +
        (row.path ? ` at ${row.path}:${row.line}` : '') +
        (parent ? ' (reply)' : '') +
        (row.findingFingerprint ? ' on a finding' : ''),
      metadata: {
        pullRequestId,
        path: row.path,
        line: row.line,
        isReply: parent !== null,
        findingFingerprint: row.findingFingerprint,
        // Length rather than the text. The body is already stored on the row, and duplicating
        // user prose into the audit trail doubles the retention surface for no benefit.
        bodyLength: row.body.length,
      },
      traceId: actor.traceId,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });

    return toCommentView(row, []);
  }

  /**
   * Edit a comment body.
   *
   * Author only, including for admins. An administrator can delete a comment they consider
   * inappropriate, but rewriting what someone else said while leaving their name on it is a
   * different act, and no role should be able to do it silently.
   */
  async update(actor: ActorContext, commentId: string, body: string): Promise<CommentView> {
    const existing = await this.requireComment(actor.organizationId, commentId);

    if (existing.authorId !== actor.userId) {
      throw new ForbiddenError(
        'Only the author can edit a comment. If it needs to be removed, delete it instead.',
      );
    }

    if (existing.origin === CommentOrigin.AI) {
      throw new ForbiddenError(
        'AI-authored comments cannot be edited. Reply to it, or resolve the thread.',
      );
    }

    const row = await this.prisma.unscoped.comment.update({
      where: { id: commentId },
      // editedAt is set so the UI can mark the comment as edited. A silently mutable comment in
      // a review thread lets the record of a decision be changed after the fact.
      data: { body, editedAt: new Date() },
      include: COMMENT_INCLUDE,
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      action: AuditAction.COMMENT_UPDATED,
      actorId: actor.userId,
      resourceType: 'Comment',
      resourceId: commentId,
      description: `Edited a comment on pull request ${existing.pullRequestId}`,
      metadata: {
        pullRequestId: existing.pullRequestId,
        previousBodyLength: existing.body.length,
        newBodyLength: body.length,
      },
      traceId: actor.traceId,
    });

    return toCommentView(row, []);
  }

  /**
   * Delete a comment.
   *
   * Author, or ADMIN and above for moderation.
   *
   * A comment with replies is refused rather than cascaded. The schema has
   * `onDelete: Cascade` on the self-relation and no tombstone column, so deleting a thread root
   * would silently destroy other people's replies — and the person deleting cannot see what
   * they are about to take with it. Refusing with a clear reason is the honest behaviour
   * available without a schema change; adding a `deletedAt` column is the real fix and is the
   * documented follow-up.
   */
  async remove(actor: ActorContext, commentId: string): Promise<void> {
    const existing = await this.requireComment(actor.organizationId, commentId);

    const isAuthor = existing.authorId === actor.userId;
    const isModerator = roleAtLeast(actor.role, Role.ADMIN);

    if (!isAuthor && !isModerator) {
      throw new ForbiddenError(
        'Only the author, or an admin, can delete a comment.',
        { role: actor.role },
      );
    }

    const replyCount = await this.prisma.unscoped.comment.count({
      where: { parentId: commentId },
    });

    if (replyCount > 0) {
      throw new ConflictError(
        `This comment has ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'} and deleting it ` +
          `would remove them too. Edit the comment instead, or delete the replies first.`,
        { replyCount },
      );
    }

    await this.prisma.unscoped.comment.delete({ where: { id: commentId } });

    await this.audit.record({
      organizationId: actor.organizationId,
      action: AuditAction.COMMENT_DELETED,
      actorId: actor.userId,
      resourceType: 'Comment',
      resourceId: commentId,
      description:
        `Deleted a comment on pull request ${existing.pullRequestId}` +
        (isAuthor ? '' : ' (moderated)'),
      metadata: {
        pullRequestId: existing.pullRequestId,
        moderated: !isAuthor,
        originalAuthorId: existing.authorId,
        path: existing.path,
        line: existing.line,
        // The row is gone, so this is the only surviving record of what was removed. Kept
        // because a deleted moderation target is precisely what an audit reader asks about.
        bodyLength: existing.body.length,
      },
      traceId: actor.traceId,
    });
  }

  /**
   * Resolve a thread.
   *
   * The comment author or a REVIEWER and above. Roots only: a thread has one resolution state,
   * and allowing a reply to be resolved independently would make "is this settled" ambiguous in
   * exactly the case where the gate depends on the answer.
   *
   * When the thread is linked to a finding, resolving it stops that finding blocking the merge
   * gate. That is the mechanism by which a human overrides a static analyzer — visibly, with
   * their name on it, rather than by suppressing the rule.
   */
  async resolve(actor: ActorContext, commentId: string): Promise<CommentView> {
    const existing = await this.requireComment(actor.organizationId, commentId);

    this.assertIsThreadRoot(existing);
    this.assertCanModerate(actor, existing);

    if (existing.resolvedAt) {
      throw new ConflictError('This thread is already resolved', {
        resolvedAt: existing.resolvedAt.toISOString(),
      });
    }

    const row = await this.prisma.unscoped.comment.update({
      where: { id: commentId },
      data: { resolvedAt: new Date(), resolvedById: actor.userId },
      include: COMMENT_INCLUDE,
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      action: AuditAction.COMMENT_RESOLVED,
      actorId: actor.userId,
      resourceType: 'Comment',
      resourceId: commentId,
      description:
        `Resolved a review thread on pull request ${existing.pullRequestId}` +
        (existing.findingFingerprint
          ? `, clearing finding ${existing.findingFingerprint.slice(0, 12)} from the merge gate`
          : ''),
      metadata: {
        pullRequestId: existing.pullRequestId,
        findingFingerprint: existing.findingFingerprint,
        path: existing.path,
        line: existing.line,
        // Recorded because this is the audit question that matters: resolving a thread on a
        // finding changes whether the pull request can merge.
        affectsMergeGate: existing.findingFingerprint !== null,
      },
      traceId: actor.traceId,
    });

    const replies = await this.repliesOf(commentId);
    return toCommentView(row, replies);
  }

  async reopen(actor: ActorContext, commentId: string): Promise<CommentView> {
    const existing = await this.requireComment(actor.organizationId, commentId);

    this.assertIsThreadRoot(existing);
    this.assertCanModerate(actor, existing);

    if (!existing.resolvedAt) {
      throw new ConflictError('This thread is not resolved, so there is nothing to reopen');
    }

    const row = await this.prisma.unscoped.comment.update({
      where: { id: commentId },
      data: { resolvedAt: null, resolvedById: null },
      include: COMMENT_INCLUDE,
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      action: AuditAction.COMMENT_REOPENED,
      actorId: actor.userId,
      resourceType: 'Comment',
      resourceId: commentId,
      description:
        `Reopened a review thread on pull request ${existing.pullRequestId}` +
        (existing.findingFingerprint ? ', restoring the finding to the merge gate' : ''),
      metadata: {
        pullRequestId: existing.pullRequestId,
        findingFingerprint: existing.findingFingerprint,
        previouslyResolvedById: existing.resolvedById,
        previouslyResolvedAt: existing.resolvedAt.toISOString(),
        affectsMergeGate: existing.findingFingerprint !== null,
      },
      traceId: actor.traceId,
    });

    const replies = await this.repliesOf(commentId);
    return toCommentView(row, replies);
  }

  /**
   * Threads for a pull request, nested one level.
   *
   * Loaded as a flat query and assembled in memory rather than with a recursive include:
   * threads are capped at one level of nesting, so a single pass is enough, and it keeps the
   * query count at one regardless of how many threads exist.
   */
  async listForPullRequest(
    organizationId: string,
    pullRequestId: string,
  ): Promise<CommentView[]> {
    const rows = await this.prisma.unscoped.comment.findMany({
      where: { pullRequestId, organizationId },
      include: COMMENT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });

    const repliesByParent = new Map<string, typeof rows>();

    for (const row of rows) {
      if (!row.parentId) continue;

      const bucket = repliesByParent.get(row.parentId);
      if (bucket) bucket.push(row);
      else repliesByParent.set(row.parentId, [row]);
    }

    return rows
      .filter((row) => row.parentId === null)
      .map((root) =>
        toCommentView(
          root,
          (repliesByParent.get(root.id) ?? []).map((reply) => toCommentView(reply, [])),
        ),
      );
  }

  /**
   * Fingerprints whose thread is resolved.
   *
   * Consumed by the merge gate. A fingerprint counts as addressed only when the *root* of its
   * thread is resolved, which `listForPullRequest` already guarantees by only nesting one level.
   */
  resolvedFingerprintsOf(threads: CommentView[]): Set<string> {
    const resolved = new Set<string>();

    for (const thread of threads) {
      if (thread.findingFingerprint && thread.resolvedAt) {
        resolved.add(thread.findingFingerprint);
      }
    }

    return resolved;
  }

  // ---------------------------------------------------------------- internals

  private async requireComment(organizationId: string, commentId: string) {
    const row = await this.prisma.unscoped.comment.findFirst({
      // Scoped by organization, so a comment id from another tenant is indistinguishable from
      // one that does not exist.
      where: { id: commentId, organizationId },
      select: {
        id: true,
        pullRequestId: true,
        authorId: true,
        origin: true,
        body: true,
        path: true,
        line: true,
        parentId: true,
        findingFingerprint: true,
        resolvedAt: true,
        resolvedById: true,
      },
    });

    if (!row) throw new NotFoundError('Comment', commentId);
    return row;
  }

  private assertIsThreadRoot(comment: { parentId: string | null }): void {
    if (comment.parentId !== null) {
      throw new ValidationError(
        'Only the first comment in a thread can be resolved or reopened. Resolution applies to ' +
          'the whole thread.',
      );
    }
  }

  private assertCanModerate(
    actor: ActorContext,
    comment: { authorId: string | null },
  ): void {
    const isAuthor = comment.authorId === actor.userId;

    if (!isAuthor && !roleAtLeast(actor.role, Role.REVIEWER)) {
      throw new ForbiddenError(
        'Resolving or reopening someone else\u2019s thread requires the REVIEWER role or ' +
          `higher; your role is ${actor.role}.`,
        { role: actor.role },
      );
    }
  }

  private async repliesOf(parentId: string): Promise<CommentView[]> {
    const rows = await this.prisma.unscoped.comment.findMany({
      where: { parentId },
      include: COMMENT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => toCommentView(row, []));
  }

  /**
   * A reply target must be in the same pull request and must itself be a root.
   *
   * The same-pull-request check is not paranoia: without it, a caller could reply to a comment
   * on a different pull request and the reply would be returned under this pull request's
   * threads, moving discussion between reviews.
   */
  private async resolveParent(
    organizationId: string,
    pullRequestId: string,
    parentId: string,
  ) {
    const parent = await this.prisma.unscoped.comment.findFirst({
      where: { id: parentId, pullRequestId, organizationId },
      select: {
        id: true,
        parentId: true,
        path: true,
        line: true,
        side: true,
        findingFingerprint: true,
      },
    });

    if (!parent) {
      throw new ValidationError(
        'The comment you are replying to does not exist on this pull request.',
        { parentId: ['Not found in this review session'] },
      );
    }

    if (parent.parentId !== null) {
      throw new ValidationError(
        'Replies are one level deep. Reply to the first comment in the thread instead.',
        { parentId: ['Already a reply'] },
      );
    }

    return parent;
  }

  /**
   * The commented path must exist in the diff.
   *
   * A comment anchored to a file the change never touched cannot be rendered next to anything
   * and reads as a silent failure. Checking on write turns it into a clear error at the point
   * the mistake is made.
   */
  private async assertPathIsInDiff(pullRequestId: string, path: string): Promise<void> {
    const file = await this.prisma.unscoped.pullRequestFile.findFirst({
      where: { pullRequestId, filename: path },
      select: { id: true },
    });

    if (file) return;

    const available = await this.prisma.unscoped.pullRequestFile.findMany({
      where: { pullRequestId },
      select: { filename: true },
      take: 20,
    });

    throw new ValidationError(`${path} is not one of the files changed in this pull request`, {
      path: [
        available.length > 0
          ? `Changed files include: ${available.map((entry) => entry.filename).join(', ')}`
          : 'This pull request has no recorded file changes yet. Run the analysis first.',
      ],
    });
  }

  /**
   * The finding fingerprint must belong to this pull request.
   *
   * Checked against both static findings and the AI review's findings, because a reviewer
   * replies to whichever surfaced the issue and both carry fingerprints. An unvalidated
   * fingerprint would silently never clear the merge gate, since the gate matches on exactly
   * this value — the thread would look resolved and the pull request would stay blocked with no
   * indication why.
   */
  private async assertFingerprintExists(
    organizationId: string,
    pullRequestId: string,
    fingerprint: string,
  ): Promise<void> {
    const staticMatch = await this.prisma.unscoped.staticFinding.findFirst({
      where: { organizationId, fingerprint, reviewRun: { pullRequestId } },
      select: { id: true },
    });

    if (staticMatch) return;

    const aiReviews = await this.prisma.unscoped.aiReview.findMany({
      where: { reviewRun: { pullRequestId, organizationId } },
      select: { findings: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    for (const review of aiReviews) {
      const findings = Array.isArray(review.findings) ? review.findings : [];

      const match = findings.some(
        (finding) =>
          typeof finding === 'object' &&
          finding !== null &&
          (finding as Record<string, unknown>).fingerprint === fingerprint,
      );

      if (match) return;
    }

    throw new ValidationError(
      'That finding fingerprint does not match any finding on this pull request. Omit it to ' +
        'leave a plain comment.',
      { findingFingerprint: ['Unknown for this pull request'] },
    );
  }
}

const COMMENT_INCLUDE = {
  author: { select: { id: true, name: true, avatarUrl: true } },
  resolvedBy: { select: { id: true, name: true } },
} as const;

function toCommentView(
  row: {
    id: string;
    pullRequestId: string;
    author: { id: string; name: string; avatarUrl: string | null } | null;
    origin: CommentOrigin;
    body: string;
    path: string | null;
    line: number | null;
    side: string;
    parentId: string | null;
    findingFingerprint: string | null;
    resolvedAt: Date | null;
    resolvedBy: { id: string; name: string } | null;
    editedAt: Date | null;
    outdated: boolean;
    createdAt: Date;
  },
  replies: CommentView[],
): CommentView {
  return {
    id: row.id,
    pullRequestId: row.pullRequestId,
    author: row.author,
    origin: row.origin,
    body: row.body,
    path: row.path,
    line: row.line,
    side: row.side === 'LEFT' ? 'LEFT' : 'RIGHT',
    parentId: row.parentId,
    replies,
    findingFingerprint: row.findingFingerprint,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    editedAt: row.editedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    outdated: row.outdated,
  };
}
