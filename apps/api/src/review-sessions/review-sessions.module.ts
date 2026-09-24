import { Module } from '@nestjs/common';
import { CommentsModule } from '../comments/comments.module';
import { ReviewSessionsController } from './review-sessions.controller';
import { ReviewSessionsService } from './review-sessions.service';
import { ShareLinksService } from './share-links.service';

/**
 * AnalysisModule is not imported: it is `@Global`, so `AnalysisReportService` and
 * `AnalysisService` resolve without creating an edge back into the pipeline. That matters
 * because the pipeline has no business depending on the review workspace, and an explicit
 * import here would invite someone to add the reverse edge later.
 */
@Module({
  imports: [CommentsModule],
  controllers: [ReviewSessionsController],
  providers: [ReviewSessionsService, ShareLinksService],
  exports: [ReviewSessionsService, ShareLinksService],
})
export class ReviewSessionsModule {}
