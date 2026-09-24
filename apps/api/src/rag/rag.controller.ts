import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { API_BASE_PATH, IndexRepositorySchema, Role } from '@codelens/shared';
import {
  CurrentUser,
  OrgId,
  RequireRole,
  TraceId,
  type AuthenticatedUser,
} from '../common/decorators';
import { zodBody } from '../common/zod-validation.pipe';
import { QueueService } from '../queues/queue.service';
import { RagService } from './rag.service';

/**
 * Indexing is queued by default.
 *
 * A real repository is hundreds or thousands of file fetches plus embedding calls, which
 * does not fit inside an HTTP request. `sync: true` stays available for small repositories
 * and for verification, where waiting for the result is the point.
 */
const IndexRequestSchema = IndexRepositorySchema.extend({
  sync: z.boolean().default(false),
});

const SearchContextSchema = z.object({
  query: z.string().min(1).max(20_000),
  topK: z.number().int().min(1).max(50).optional(),
  symbols: z.array(z.string().max(200)).max(200).default([]),
  excludePaths: z.array(z.string().max(300)).max(300).default([]),
  maxTokens: z.number().int().min(256).max(32_000).optional(),
});

@ApiTags('rag')
@ApiBearerAuth('access-token')
@Controller()
export class RagController {
  constructor(
    private readonly rag: RagService,
    private readonly queues: QueueService,
  ) {}

  /**
   * Index a repository.
   *
   * Queued by default and throttled hard, because it is the most expensive operation in the
   * product: GitHub file fetches plus paid embedding calls. Progress is readable either from
   * the job handle or from the index-stats endpoint while it runs.
   */
  @Post('repositories/:id/index')
  @RequireRole(Role.REVIEWER)
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Index a repository for retrieval-augmented review context',
    description:
      'Returns 202 with a job handle. Poll GET /jobs/{id}, or GET /repositories/{id}/index ' +
      'for index-run detail. With sync: true the index runs inline.',
  })
  async index(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') repositoryId: string,
    @Body(zodBody(IndexRequestSchema)) body: ReturnType<typeof IndexRequestSchema.parse>,
    @TraceId() traceId: string,
  ) {
    if (body.sync) {
      return {
        mode: 'sync' as const,
        job: null,
        progress: await this.rag.indexRepository({
          organizationId,
          repositoryId,
          userId: user.userId,
          force: body.force,
          ...(body.maxFiles ? { maxFiles: body.maxFiles } : {}),
          includePaths: body.includePaths,
        }),
      };
    }

    // Existence is checked before enqueuing so a bad id is a 404 now rather than a failed
    // job the caller has to go looking for.
    await this.rag.indexStats(organizationId, repositoryId);

    const job = await this.queues.enqueueIndex({
      organizationId,
      repositoryId,
      userId: user.userId,
      traceId,
      force: body.force,
      maxFiles: body.maxFiles ?? null,
      includePaths: body.includePaths,
    });

    return {
      mode: 'queued' as const,
      job,
      pollUrl: `${API_BASE_PATH}/jobs/${encodeURIComponent(job.id)}`,
      progress: null,
    };
  }

  @Get('repositories/:id/index')
  @ApiOperation({ summary: 'Index status, chunk counts and the latest index run' })
  indexStats(@OrgId() organizationId: string, @Param('id') repositoryId: string) {
    return this.rag.indexStats(organizationId, repositoryId);
  }

  /**
   * Ad-hoc context search.
   *
   * Backs the RAG context viewer, where a reviewer can ask what the retriever would surface for
   * a given query. Returns per-strategy candidate counts and a rationale per chunk, so the
   * retrieval is inspectable rather than opaque.
   */
  @Post('repositories/:id/search-context')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Search indexed repository context with hybrid retrieval' })
  searchContext(
    @OrgId() organizationId: string,
    @Param('id') repositoryId: string,
    @Body(zodBody(SearchContextSchema)) body: ReturnType<typeof SearchContextSchema.parse>,
  ) {
    return this.rag.searchContext(organizationId, repositoryId, {
      query: body.query,
      ...(body.topK ? { topK: body.topK } : {}),
      symbols: body.symbols,
      excludePaths: body.excludePaths,
      ...(body.maxTokens ? { maxTokens: body.maxTokens } : {}),
    });
  }

  /**
   * The context recorded for a pull request's latest run.
   *
   * Reads the persisted snapshot rather than re-retrieving, so it shows what the AI actually saw
   * even after the repository has been re-indexed. Re-running retrieval would show today's
   * answer for yesterday's review.
   */
  @Get('pull-requests/:id/rag-context')
  @ApiOperation({ summary: 'Repository context the AI saw for this pull request' })
  prContext(@OrgId() organizationId: string, @Param('id') pullRequestId: string) {
    return this.rag.getRunContext(organizationId, pullRequestId);
  }
}
