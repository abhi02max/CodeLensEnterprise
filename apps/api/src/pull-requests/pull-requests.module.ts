import { Module } from '@nestjs/common';
import { PullRequestsController } from './pull-requests.controller';
import { PullRequestsService } from './pull-requests.service';

/**
 * Exported because the analysis pipeline and the review-session module both need to read
 * pull request state and to guarantee a diff has been imported.
 */
@Module({
  controllers: [PullRequestsController],
  providers: [PullRequestsService],
  exports: [PullRequestsService],
})
export class PullRequestsModule {}
