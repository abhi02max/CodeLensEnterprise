import { Module } from '@nestjs/common';
import { CollaborationController } from './collaboration.controller';
import { CollaborationService } from './collaboration.service';
import { InvestigationController } from './investigation.controller';
import { InvestigationService } from './investigation.service';
import { InvestigationToolsService } from './investigation-tools.service';
import { CollaborationExecutionService } from './collaboration-execution.service';
import { CollaborationProviderService } from './collaboration-provider.service';
import { PatchProposalService } from './patch-proposal.service';
import { PatchProposalController } from './patch-proposal.controller';
import { PatchApplicationController } from './patch-application.controller';
import { PatchApplicationService } from './patch-application.service';
import { ValidationController } from './validation.controller';
import { ValidationService } from './validation.service';
import { ValidationMlService } from './validation-ml.service';
import { ValidationMlController } from './validation-ml.controller';

@Module({
  controllers: [
    CollaborationController,
    InvestigationController,
    PatchProposalController,
    PatchApplicationController,
    ValidationController,
    ValidationMlController,
  ],
  providers: [
    CollaborationService,
    InvestigationService,
    InvestigationToolsService,
    CollaborationExecutionService,
    CollaborationProviderService,
    PatchProposalService,
    PatchApplicationService,
    ValidationService,
    ValidationMlService,
  ],
  exports: [
    CollaborationExecutionService,
    PatchApplicationService,
    ValidationService,
    ValidationMlService,
  ],
})
export class CollaborationModule {}
