import { Module } from '@nestjs/common';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

/**
 * Exported because the review workspace embeds threads and derives part of its merge gate from
 * which finding-linked threads are resolved. ReviewSessionsModule imports this rather than
 * querying Comment directly, so "a resolved thread clears a finding" is defined once.
 */
@Module({
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
