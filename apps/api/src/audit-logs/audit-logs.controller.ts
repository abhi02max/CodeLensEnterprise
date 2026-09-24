import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ListAuditLogsQuerySchema, Role } from '@codelens/shared';
import { OrgId, RequireRole } from '../common/decorators';
import { zodQuery } from '../common/zod-validation.pipe';
import { AuditService } from './audit.service';

/**
 * Audit log read API.
 *
 * ADMIN-only. The trail records who connected which repository, whose token was used,
 * and what every analysis run did, which is more than a DEVELOPER needs and enough to
 * map an organization's internal structure.
 */
@ApiTags('audit-logs')
@ApiBearerAuth('access-token')
@Controller('audit-logs')
@RequireRole(Role.ADMIN)
export class AuditLogsController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'List audit log entries for the active organization' })
  list(
    @OrgId() organizationId: string,
    @Query(zodQuery(ListAuditLogsQuerySchema)) query: ReturnType<typeof ListAuditLogsQuerySchema.parse>,
  ) {
    return this.audit.list(organizationId, query);
  }

  @Get('actions')
  @ApiOperation({ summary: 'Distinct audit actions present, for building filters' })
  actions(@OrgId() organizationId: string) {
    return this.audit.availableActions(organizationId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single audit log entry' })
  findOne(@OrgId() organizationId: string, @Param('id') id: string) {
    return this.audit.findOne(organizationId, id);
  }
}
