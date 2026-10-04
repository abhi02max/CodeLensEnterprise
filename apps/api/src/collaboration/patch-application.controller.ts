import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ListConversationsSchema,
  PatchApplicationRequestSchema,
  PatchApplicationCancelSchema,
  Role,
} from '@codelens/shared';
import {
  CurrentUser,
  OrgId,
  RequireRole,
  TraceId,
  type AuthenticatedUser,
} from '../common/decorators';
import { zodBody, zodQuery } from '../common/zod-validation.pipe';
import { PatchApplicationService } from './patch-application.service';

@RequireRole(Role.DEVELOPER)
@Controller()
export class PatchApplicationController {
  constructor(private readonly applications: PatchApplicationService) {}
  @Post('patch-proposals/:id/applications')
  @HttpCode(202)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  request(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Body(zodBody(PatchApplicationRequestSchema))
    input: ReturnType<typeof PatchApplicationRequestSchema.parse>,
  ) {
    return this.applications.request({ organizationId, userId: user.userId, traceId }, id, input);
  }
  @Get('patch-applications/:id')
  get(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
  ) {
    return this.applications.get({ organizationId, userId: user.userId, traceId }, id);
  }
  @Get('patch-proposals/:id/applications')
  list(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Query(zodQuery(ListConversationsSchema))
    query: ReturnType<typeof ListConversationsSchema.parse>,
  ) {
    return this.applications.list({ organizationId, userId: user.userId, traceId }, id, query);
  }
  @Post('patch-applications/:id/cancel')
  @HttpCode(200)
  cancel(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Body(zodBody(PatchApplicationCancelSchema))
    input: ReturnType<typeof PatchApplicationCancelSchema.parse>,
  ) {
    return this.applications.cancel(
      { organizationId, userId: user.userId, traceId },
      id,
      input.requestId,
    );
  }
}
