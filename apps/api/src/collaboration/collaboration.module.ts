import { Module } from '@nestjs/common';
import { CollaborationController } from './collaboration.controller';
import { CollaborationService } from './collaboration.service';
import { InvestigationController } from './investigation.controller';
import { InvestigationService } from './investigation.service';
import { InvestigationToolsService } from './investigation-tools.service';
import { CollaborationExecutionService } from './collaboration-execution.service';
import { CollaborationProviderService } from './collaboration-provider.service';

@Module({
  controllers: [CollaborationController, InvestigationController],
  providers: [
    CollaborationService,
    InvestigationService,
    InvestigationToolsService,
    CollaborationExecutionService,
    CollaborationProviderService,
  ],
  exports: [CollaborationExecutionService],
})
export class CollaborationModule {}
