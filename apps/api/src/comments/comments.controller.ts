import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CreateCommentSchema, Role, UpdateCommentSchema } from '@codelens/shared';
import {
  CurrentUser,
  OrgId,
  RequestMeta,
  RequireRole,
  TraceId,
  type AuthenticatedUser,
} from '../common/decorators';
import { zodBody } from '../common/zod-validation.pipe';
import { CommentsService } from './comments.service';

/**
 * Review discussion.
 *
 * Creation and listing live under the session because a comment only means something inside
 * one, while mutation of an existing comment is addressed by the comment's own id — the caller
 * already holds it from the thread, and requiring the session id as well would let the two
 * disagree.
 */
@ApiTags('comments')
@ApiBearerAuth('access-token')
@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  /**
   * Comment on a review session.
   *
   * Three shapes, distinguished by what is supplied: omit `path`/`line` for a general comment,
   * give both for an inline one, add `findingFingerprint` to attach the thread to a specific
   * finding, and give `parentId` to reply. A fingerprint-linked thread that gets resolved stops
   * that finding blocking the merge gate.
   */
  @Post('review-sessions/:id/comments')
  @RequireRole(Role.DEVELOPER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a comment, inline comment, finding comment or reply' })
  create(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') sessionId: string,
    @Body(zodBody(CreateCommentSchema)) body: ReturnType<typeof CreateCommentSchema.parse>,
    @RequestMeta() meta: { ipAddress: string | null; userAgent: string | null },
    @TraceId() traceId: string,
  ) {
    return this.comments.create(
      {
        organizationId,
        userId: user.userId,
        role: user.role ?? Role.DEVELOPER,
        traceId,
        ...meta,
      },
      sessionId,
      body,
    );
  }

  @Get('review-sessions/:id/comments')
  @ApiOperation({ summary: 'Threads for a review session, nested one level' })
  list(@OrgId() organizationId: string, @Param('id') sessionId: string) {
    return this.comments.listForPullRequest(organizationId, sessionId);
  }

  @Patch('comments/:id')
  @RequireRole(Role.DEVELOPER)
  @ApiOperation({
    summary: 'Edit your own comment',
    description: 'Author only, including for admins. Marks the comment as edited.',
  })
  update(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(UpdateCommentSchema)) body: ReturnType<typeof UpdateCommentSchema.parse>,
    @TraceId() traceId: string,
  ) {
    return this.comments.update(
      { organizationId, userId: user.userId, role: user.role ?? Role.DEVELOPER, traceId },
      id,
      body.body,
    );
  }

  @Delete('comments/:id')
  @RequireRole(Role.DEVELOPER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a comment',
    description:
      'Author, or ADMIN and above for moderation. Refused with 409 when the comment has ' +
      'replies, because deleting it would cascade and remove them too.',
  })
  async remove(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @TraceId() traceId: string,
  ): Promise<void> {
    await this.comments.remove(
      { organizationId, userId: user.userId, role: user.role ?? Role.DEVELOPER, traceId },
      id,
    );
  }

  @Post('comments/:id/resolve')
  @RequireRole(Role.DEVELOPER)
  @ApiOperation({
    summary: 'Resolve a thread',
    description:
      'Thread roots only. Author, or REVIEWER and above for threads started by someone else. ' +
      'Resolving a thread linked to a finding clears that finding from the merge gate.',
  })
  resolve(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @TraceId() traceId: string,
  ) {
    return this.comments.resolve(
      { organizationId, userId: user.userId, role: user.role ?? Role.DEVELOPER, traceId },
      id,
    );
  }

  @Post('comments/:id/reopen')
  @RequireRole(Role.DEVELOPER)
  @ApiOperation({
    summary: 'Reopen a resolved thread',
    description: 'Restores a finding-linked thread to the merge gate.',
  })
  reopen(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @TraceId() traceId: string,
  ) {
    return this.comments.reopen(
      { organizationId, userId: user.userId, role: user.role ?? Role.DEVELOPER, traceId },
      id,
    );
  }
}
