import { Module } from '@nestjs/common';
import { CollaborationController } from './collaboration.controller';
import { CollaborationService } from './collaboration.service';
import { InvestigationController } from './investigation.controller';
import { InvestigationService } from './investigation.service';
import { InvestigationToolsService } from './investigation-tools.service';

@Module({
  controllers: [CollaborationController, InvestigationController],
  providers: [CollaborationService, InvestigationService, InvestigationToolsService],
})
export class CollaborationModule {}
