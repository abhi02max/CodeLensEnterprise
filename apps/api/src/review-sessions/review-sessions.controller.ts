import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import {
  API_BASE_PATH,
  CreateShareLinkSchema,
  Role,
  SubmitReviewSchema,
} from '@codelens/shared';
import { ReviewVerdict, RunTrigger } from '@codelens/database';
import {
  CurrentUser,
  OrgId,
  Public,
  RequestMeta,
  RequireRole,
  TraceId,
  type AuthenticatedUser,
} from '../common/decorators';
import { zodBody } from '../common/zod-validation.pipe';
import { AnalysisService } from '../analysis/analysis.service';
import { ReviewSessionsService } from './review-sessions.service';
import { ShareLinksService } from './share-links.service';

/**
 * Opening a session optionally makes sure the analysis is current.
 *
 * Without this the first thing a reviewer sees on a PR whose branch moved is a stale analysis
 * with no indication that it is stale until they read the degradation notes.
 */
const OpenSessionSchema = z.object({
  pullRequestId: z.string().min(1),
  /** Queue an analysis when there is none, or when the last one predates the current head. */
  analyzeIfStale: z.boolean().default(true),
  /** Re-analyse even if a current run exists. */
  force: z.boolean().default(false),
});

/** A verdict body, minus the verdict: the route determines that. */
const VerdictBodySchema = SubmitReviewSchema.omit({ verdict: true });

@ApiTags('review-sessions')
@Controller('review-sessions')
export class ReviewSessionsController {
  constructor(
    private readonly sessions: ReviewSessionsService,
    private readonly shareLinks: ShareLinksService,
    private readonly analysis: AnalysisService,
  ) {}

  /**
   * Open the review workspace for a pull request.
   *
   * No row is created: a review session is a view over the pull request, its latest ReviewRun,
   * its verdicts, its threads and its share links, and the session id is the pull request id.
   * POST rather than GET because this can cause work — it queues an analysis when the existing
   * one does not describe the current head.
   */
  @Post()
  @ApiBearerAuth('access-token')
  @RequireRole(Role.DEVELOPER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open a review session for a pull request, refreshing the analysis if stale',
  })
  async open(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(OpenSessionSchema)) body: ReturnType<typeof OpenSessionSchema.parse>,
    @TraceId() traceId: string,
  ) {
    const session = await this.sessions.getSession({
      organizationId,
      pullRequestId: body.pullRequestId,
      userId: user.userId,
      role: user.role ?? Role.DEVELOPER,
    });

    const needsAnalysis =
      body.force || !session.analyzed || (session.run?.stale ?? false);

    const job =
      body.analyzeIfStale && needsAnalysis
        ? await this.analysis.enqueue({
            organizationId,
            pullRequestId: body.pullRequestId,
            userId: user.userId,
            userRole: user.role ?? Role.DEVELOPER,
            traceId,
            trigger: RunTrigger.USER,
            force: body.force,
            postToGithub: false,
          })
        : null;

    return {
      session,
      // Non-null when opening the session queued a run. The workspace above still reflects the
      // previous analysis, so the client polls this and refetches rather than being handed a
      // payload that is about to change.
      job,
      ...(job ? { pollUrl: `${API_BASE_PATH}/jobs/${encodeURIComponent(job.id)}` } : {}),
    };
  }

  /**
   * The share route is declared before `:id` because Nest matches in declaration order and
   * `share` would otherwise be read as a pull request id.
   */
  @Get('share/:token')
  @Public()
  // Tightened well below the global default. This is the only unauthenticated data path in the
  // product, so it gets its own budget rather than sharing the dashboard's.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiHeader({
    name: 'X-Share-Passphrase',
    required: false,
    description: 'Required only when the link was created with a passphrase.',
  })
  @ApiParam({ name: 'token', description: 'Raw share token from the shared URL' })
  @ApiOperation({
    summary: 'Read a shared review without authentication',
    description:
      'Returns a redacted payload built from an explicit allowlist. Tool run outputs, audit ' +
      'entries, share links, permissions and reviewer email addresses are never included, and ' +
      'source snippets are omitted when the link was created with redactCode. An unknown, ' +
      'expired or revoked token returns 404 without distinguishing which.',
  })
  async shared(
    @Param('token') token: string,
    @Headers('x-share-passphrase') passphrase: string | undefined,
    @RequestMeta() meta: { ipAddress: string | null; userAgent: string | null },
    @TraceId() traceId: string,
  ) {
    const link = await this.shareLinks.resolve(token, passphrase ?? null);

    const payload = await this.sessions.getSharedSession({
      organizationId: link.organizationId,
      pullRequestId: link.pullRequestId,
      scope: link.scope,
      redactCode: link.redactCode,
      expiresAt: link.expiresAt,
    });

    // After the payload is assembled, so a failed read is not counted as a view.
    await this.shareLinks.recordView(link, { ...meta, traceId });

    return payload;
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'The review workspace: analysis, risk, findings, verdicts, threads and permissions',
  })
  get(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.sessions.getSession({
      organizationId,
      pullRequestId: id,
      userId: user.userId,
      role: user.role ?? Role.DEVELOPER,
    });
  }

  @Post(':id/approve')
  @ApiBearerAuth('access-token')
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'Approve the change at its current head',
    description:
      'Creates or revises a Review row with verdict APPROVED for the current head SHA. The ' +
      'pull request author cannot approve their own change. Returns the recomputed merge gate.',
  })
  approve(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(VerdictBodySchema)) body: ReturnType<typeof VerdictBodySchema.parse>,
    @RequestMeta() meta: { ipAddress: string | null; userAgent: string | null },
    @TraceId() traceId: string,
  ) {
    return this.sessions.submitVerdict({
      organizationId,
      pullRequestId: id,
      userId: user.userId,
      role: user.role ?? Role.DEVELOPER,
      verdict: ReviewVerdict.APPROVED,
      input: { verdict: 'APPROVED', ...body },
      traceId,
      ...meta,
    });
  }

  @Post(':id/request-changes')
  @ApiBearerAuth('access-token')
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'Request changes on the current head',
    description:
      'Creates or revises a Review row with verdict CHANGES_REQUESTED, which blocks the merge ' +
      'gate and labels the pull request as risky for model training.',
  })
  requestChanges(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(VerdictBodySchema)) body: ReturnType<typeof VerdictBodySchema.parse>,
    @RequestMeta() meta: { ipAddress: string | null; userAgent: string | null },
    @TraceId() traceId: string,
  ) {
    return this.sessions.submitVerdict({
      organizationId,
      pullRequestId: id,
      userId: user.userId,
      role: user.role ?? Role.DEVELOPER,
      verdict: ReviewVerdict.CHANGES_REQUESTED,
      input: { verdict: 'CHANGES_REQUESTED', ...body },
      traceId,
      ...meta,
    });
  }

  /**
   * Mint a share link.
   *
   * ADMIN and above: this is the one action that makes tenant data readable without
   * authentication, and it is not reversible for anyone who already opened the URL.
   */
  @Post(':id/share-link')
  @ApiBearerAuth('access-token')
  @RequireRole(Role.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a share link',
    description:
      'Only the sha256 of the token is stored, so the returned url and token appear exactly ' +
      'once and cannot be recovered afterwards.',
  })
  createShareLink(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(CreateShareLinkSchema)) body: ReturnType<typeof CreateShareLinkSchema.parse>,
    @RequestMeta() meta: { ipAddress: string | null; userAgent: string | null },
    @TraceId() traceId: string,
  ) {
    return this.shareLinks.create({
      organizationId,
      pullRequestId: id,
      userId: user.userId,
      input: body,
      traceId,
      ...meta,
    });
  }

  @Get(':id/share-link')
  @ApiBearerAuth('access-token')
  @RequireRole(Role.ADMIN)
  @ApiOperation({
    summary: 'List share links for a session',
    description: 'Tokens are not included; url is empty because only the hash is stored.',
  })
  listShareLinks(@OrgId() organizationId: string, @Param('id') id: string) {
    return this.shareLinks.list(organizationId, id);
  }

  /**
   * Revoke a share link.
   *
   * Sets `revokedAt` rather than deleting the row, so who shared the review and when it was cut
   * off survives the revocation. Returns the updated link rather than 204 so the caller can show
   * the final view count.
   */
  @Delete(':id/share-link/:shareLinkId')
  @ApiBearerAuth('access-token')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'Revoke a share link' })
  revokeShareLink(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('shareLinkId') shareLinkId: string,
    @TraceId() traceId: string,
  ) {
    return this.shareLinks.revoke({
      organizationId,
      pullRequestId: id,
      shareLinkId,
      userId: user.userId,
      traceId,
    });
  }
}
