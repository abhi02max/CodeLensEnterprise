import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import {
  API_BASE_PATH,
  ConnectRepositorySchema,
  ListPullRequestsQuerySchema,
  ListRepositoriesQuerySchema,
  Role,
  SyncPullRequestsSchema,
} from '@codelens/shared';
import {
  CurrentUser,
  OrgId,
  RequestMeta,
  RequireRole,
  TraceId,
  type AuthenticatedUser,
} from '../common/decorators';
import { zodBody, zodQuery } from '../common/zod-validation.pipe';
import { PullRequestsService } from '../pull-requests/pull-requests.service';
import { QueueService } from '../queues/queue.service';
import { RepositoriesService } from './repositories.service';

/** Sync accepts an optional repositoryId; omitting it syncs every connected repository. */
const SyncRequestSchema = SyncPullRequestsSchema.extend({
  repositoryId: z.string().min(1).optional(),
});

@ApiTags('repositories')
@ApiBearerAuth('access-token')
@Controller('repositories')
export class RepositoriesController {
  constructor(
    private readonly repositories: RepositoriesService,
    private readonly pullRequestsService: PullRequestsService,
    private readonly queues: QueueService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List connected repositories' })
  list(
    @OrgId() organizationId: string,
    @Query(zodQuery(ListRepositoriesQuerySchema))
    query: ReturnType<typeof ListRepositoriesQuerySchema.parse>,
  ) {
    return this.repositories.list(organizationId, query);
  }

  /**
   * Repositories the caller can see on GitHub but has not necessarily connected.
   *
   * Throttled because each cache miss costs several GitHub API calls against an hourly
   * budget shared by analysis runs.
   */
  @Get('available')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'List GitHub repositories available to connect' })
  available(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('search') search: string | undefined,
    @Query('refresh') refresh: string | undefined,
  ) {
    return this.repositories.listAvailable(organizationId, user.userId, {
      ...(search ? { search } : {}),
      refresh: refresh === 'true',
    });
  }

  @Post()
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'Connect a GitHub repository to this organization' })
  connect(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(ConnectRepositorySchema))
    body: ReturnType<typeof ConnectRepositorySchema.parse>,
    @RequestMeta() meta: { ipAddress: string | null; userAgent: string | null },
    @TraceId() traceId: string,
  ) {
    return this.repositories.connect(organizationId, user.userId, body, { ...meta, traceId });
  }

  /**
   * Refresh metadata and pull requests from GitHub.
   *
   * Queued rather than run inline. With no `repositoryId` this syncs every connected
   * repository, which is N sequential GitHub round trips — the dashboard refresh button was
   * previously holding an HTTP connection open for all of them. The fan-out itself now lives
   * in the pr-sync processor, which is also what a webhook or a schedule would drive.
   */
  @Post('sync')
  @RequireRole(Role.REVIEWER)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Queue a sync of one repository, or of all of them when repositoryId is omitted',
  })
  async sync(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(SyncRequestSchema)) body: ReturnType<typeof SyncRequestSchema.parse>,
    @TraceId() traceId: string,
  ) {
    // Validated up front so a bad id is a 404 rather than a job that quietly syncs nothing.
    if (body.repositoryId) await this.repositories.findOne(organizationId, body.repositoryId);

    const job = await this.queues.enqueueSync({
      organizationId,
      userId: user.userId,
      traceId,
      repositoryId: body.repositoryId ?? null,
      state: body.state,
      limit: body.limit,
    });

    return {
      mode: 'queued' as const,
      job,
      pollUrl: `${API_BASE_PATH}/jobs/${encodeURIComponent(job.id)}`,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Repository detail' })
  findOne(@OrgId() organizationId: string, @Param('id') id: string) {
    return this.repositories.findOne(organizationId, id);
  }

  /**
   * Sync a single repository inline.
   *
   * Kept synchronous because one repository is a handful of GitHub calls and the caller
   * almost always wants the refreshed pull request list in the same response. Use
   * `POST /repositories/sync` for the queued, organization-wide variant.
   */
  @Post(':id/sync')
  @RequireRole(Role.REVIEWER)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sync a single repository inline' })
  syncOne(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(SyncPullRequestsSchema)) body: ReturnType<typeof SyncPullRequestsSchema.parse>,
  ) {
    return this.repositories.sync(organizationId, id, user.userId, {
      state: body.state,
      limit: body.limit,
    });
  }

  @Delete(':id')
  @RequireRole(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect a repository and delete its analysis history' })
  async disconnect(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.repositories.disconnect(organizationId, id, user.userId);
  }

  @Get(':id/pull-requests')
  @ApiOperation({ summary: 'List pull requests for a repository' })
  async pullRequests(
    @OrgId() organizationId: string,
    @Param('id') id: string,
    @Query(zodQuery(ListPullRequestsQuerySchema))
    query: ReturnType<typeof ListPullRequestsQuerySchema.parse>,
  ) {
    // Resolve the repository first so an id belonging to another organization produces a
    // 404 before any pull request data is touched.
    await this.repositories.findOne(organizationId, id);
    return this.pullRequestsService.list(organizationId, { ...query, repositoryId: id });
  }
}
