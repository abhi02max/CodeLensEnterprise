import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { InvestigationRequestSchema, InvestigationPageSchema, Role } from '@codelens/shared';
import {
  CurrentUser,
  OrgId,
  RequireRole,
  TraceId,
  type AuthenticatedUser,
} from '../common/decorators';
import { zodBody, zodQuery } from '../common/zod-validation.pipe';
import { InvestigationService } from './investigation.service';
import { NotFoundError } from '../common/errors';

@RequireRole(Role.DEVELOPER)
@Controller()
export class InvestigationController {
  constructor(private readonly investigation: InvestigationService) {}
  @Post('collaboration-turns/:turnId/tools/:tool')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async execute(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('turnId') turnId: string,
    @Param('tool') tool: string,
    @Body(zodBody(InvestigationRequestSchema))
    input: ReturnType<typeof InvestigationRequestSchema.parse>,
  ) {
    const result = await this.investigation.execute(
      { organizationId, userId: user.userId, traceId },
      turnId,
      tool,
      input.requestId,
      input.input,
    );
    if (result.failureCategory === 'NOT_FOUND' || result.failureCategory === 'FORBIDDEN')
      throw new NotFoundError('Investigation context');
    return result;
  }
  @Get('collaboration-tools/:id')
  get(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
  ) {
    return this.investigation.getCall({ organizationId, userId: user.userId, traceId }, id);
  }
  @Get('evidence-references/:id')
  evidence(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
  ) {
    return this.investigation.getEvidence({ organizationId, userId: user.userId, traceId }, id);
  }
  @Get('collaboration-turns/:turnId/evidence')
  list(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('turnId') id: string,
    @Query(zodQuery(InvestigationPageSchema))
    page: ReturnType<typeof InvestigationPageSchema.parse>,
  ) {
    return this.investigation.list({ organizationId, userId: user.userId, traceId }, id, page);
  }
}
