import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ListPullRequestsQuerySchema } from '@codelens/shared';
import { CurrentUser, OrgId, type AuthenticatedUser } from '../common/decorators';
import { zodBody, zodQuery } from '../common/zod-validation.pipe';
import { PullRequestsService } from './pull-requests.service';

const ImportPullRequestSchema = z.object({
  repositoryId: z.string().min(1),
  number: z.coerce.number().int().positive(),
});

@ApiTags('pull-requests')
@ApiBearerAuth('access-token')
@Controller('pull-requests')
export class PullRequestsController {
  constructor(private readonly pullRequests: PullRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'List pull requests across the organization' })
  list(
    @OrgId() organizationId: string,
    @Query(zodQuery(ListPullRequestsQuerySchema))
    query: ReturnType<typeof ListPullRequestsQuerySchema.parse>,
  ) {
    return this.pullRequests.list(organizationId, query);
  }

  /**
   * Import a pull request from GitHub, including its full diff and commits.
   *
   * Idempotent, so it doubles as "refresh this pull request". The analysis pipeline calls
   * the same path to guarantee a diff is present before it starts.
   */
  @Post('import')
  @ApiOperation({ summary: 'Import or refresh a pull request and its diff from GitHub' })
  import(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(ImportPullRequestSchema))
    body: ReturnType<typeof ImportPullRequestSchema.parse>,
  ) {
    return this.pullRequests.importFromGithub(organizationId, {
      repositoryId: body.repositoryId,
      number: body.number,
      userId: user.userId,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Pull request detail with files, commits and finding counts' })
  findOne(@OrgId() organizationId: string, @Param('id') id: string) {
    return this.pullRequests.findOne(organizationId, id);
  }

  @Get(':id/files')
  @ApiOperation({ summary: 'Changed files with unified diff patches' })
  files(@OrgId() organizationId: string, @Param('id') id: string) {
    return this.pullRequests.getFiles(organizationId, id);
  }
}
