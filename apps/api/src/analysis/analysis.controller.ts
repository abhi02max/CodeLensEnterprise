import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { API_BASE_PATH, Role } from '@codelens/shared';
import { RunTrigger } from '@codelens/database';
import {
  CurrentUser,
  OrgId,
  RequireRole,
  TraceId,
  type AuthenticatedUser,
} from '../common/decorators';
import { zodBody } from '../common/zod-validation.pipe';
import { AnalysisReportService } from './analysis-report.service';
import { AnalysisService } from './analysis.service';

const AnalyzeRequestSchema = z.object({
  /** Re-run even if an equivalent completed run exists for this commit. */
  force: z.boolean().default(false),
  postToGithub: z.boolean().default(false),
  /**
   * Run synchronously instead of enqueuing. Intended for verification and small diffs; a
   * large pull request will exceed the HTTP timeout, which is why the queue is the default.
   */
  sync: z.boolean().default(false),
});

@ApiTags('analysis')
@ApiBearerAuth('access-token')
@Controller()
export class AnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly report: AnalysisReportService,
  ) {}

  /**
   * Trigger analysis of a pull request.
   *
   * Enqueues by default and returns a job id, because a full run involves static analysis,
   * an ML call, retrieval and one or more LLM calls. `sync: true` runs inline and returns the
   * finished result.
   */
  @Post('pull-requests/:id/analyze')
  @RequireRole(Role.DEVELOPER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Analyze a pull request; enqueues by default, runs inline when sync is true',
    description:
      'Returns 202 with a job handle. Poll GET /jobs/{id} for progress, or switch to ' +
      'GET /review-runs/{runId} once the job reports a reviewRunId. With sync: true the ' +
      'pipeline runs inline and the response contains the finished analysis instead.',
  })
  @ApiResponse({ status: 202, description: 'Queued, or completed when sync was requested' })
  async analyze(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') pullRequestId: string,
    @Body(zodBody(AnalyzeRequestSchema)) body: ReturnType<typeof AnalyzeRequestSchema.parse>,
    @TraceId() traceId: string,
  ) {
    const request = {
      organizationId,
      pullRequestId,
      userId: user.userId,
      userRole: user.role ?? Role.DEVELOPER,
      traceId,
      trigger: RunTrigger.USER,
      force: body.force,
      postToGithub: body.postToGithub,
    };

    if (body.sync) {
      const result = await this.analysis.run(request);

      return {
        mode: 'sync' as const,
        job: null,
        ...result,
        analysis: await this.report.getLatest(organizationId, pullRequestId),
      };
    }

    const job = await this.analysis.enqueue(request);

    return {
      mode: 'queued' as const,
      job,
      // Returned rather than left for the client to construct, so the handle encoding stays
      // an implementation detail of the API.
      pollUrl: `${API_BASE_PATH}/jobs/${encodeURIComponent(job.id)}`,
      reviewRunId: job.reviewRunId,
      status: null,
      reused: job.deduplicated,
      degradation: [],
      analysis: null,
    };
  }

  /**
   * The complete analysis payload: risk, findings, retrieved context, AI review and tool runs.
   *
   * One request rather than several because the review workspace needs all of it to render, and
   * fetching it in pieces would make the page assemble itself visibly in stages.
   */
  @Get('pull-requests/:id/analysis')
  @ApiOperation({ summary: 'Complete analysis payload for the latest run' })
  analysisFor(@OrgId() organizationId: string, @Param('id') pullRequestId: string) {
    return this.report.getLatest(organizationId, pullRequestId);
  }

  @Get('review-runs/:runId')
  @ApiOperation({ summary: 'Run status and per-tool progress, for polling' })
  runStatus(@OrgId() organizationId: string, @Param('runId') runId: string) {
    return this.report.getRunStatus(organizationId, runId);
  }
}
