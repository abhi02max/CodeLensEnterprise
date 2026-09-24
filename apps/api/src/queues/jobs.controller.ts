import { Controller, Delete, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Role } from '@codelens/shared';
import { OrgId, RequireRole } from '../common/decorators';
import { QueueService } from './queue.service';

/**
 * Background job status.
 *
 * One endpoint for every queue. The job id handed to clients embeds its queue, so adding a
 * queue does not add an endpoint and the client does not need to know the topology.
 *
 * Every read is scoped to the caller's organization. Job ids are derived from resource ids
 * and are therefore guessable, so they are treated as identifiers rather than as secrets.
 */
@ApiTags('jobs')
@ApiBearerAuth('access-token')
@Controller('jobs')
export class JobsController {
  constructor(private readonly queues: QueueService) {}

  /**
   * Queue depth and worker counts.
   *
   * Placed before `:id` because Nest matches routes in declaration order and `queues` would
   * otherwise be read as a job id.
   */
  @Get('queues')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'Queue depth, worker count and pause state for every queue' })
  queueStats() {
    return this.queues.stats();
  }

  @Get(':id')
  @ApiParam({
    name: 'id',
    description: 'Job handle of the form "<queue>:<jobId>", as returned when the job was created',
    example: 'review-run:analyze-cmudqo45f000xbgqg3vzb88s2-a1b2c3d',
  })
  @ApiOperation({ summary: 'Status, progress and result of a background job' })
  find(@OrgId() organizationId: string, @Param('id') id: string) {
    return this.queues.describe(id, organizationId);
  }

  /**
   * Cancel a job that has not started yet.
   *
   * Returns 200 with `cancelled: false` for jobs that already finished, rather than an
   * error: the caller's intent — "this should not run" — is satisfied either way.
   */
  @Delete(':id')
  @RequireRole(Role.DEVELOPER)
  @ApiOperation({ summary: 'Cancel a queued or delayed job' })
  cancel(@OrgId() organizationId: string, @Param('id') id: string) {
    return this.queues.cancel(id, organizationId);
  }
}
