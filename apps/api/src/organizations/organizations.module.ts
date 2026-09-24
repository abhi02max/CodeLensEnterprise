import { Global, Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { PolicyService } from './policy.service';

/**
 * Global because PolicyService is read by the analysis pipeline, the MCP tools and the
 * review-session module. Making each of those import this module would add coupling
 * without adding clarity.
 */
@Global()
@Module({
  controllers: [OrganizationsController],
  providers: [OrganizationsService, PolicyService],
  exports: [OrganizationsService, PolicyService],
})
export class OrganizationsModule {}
