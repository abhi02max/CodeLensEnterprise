import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ValidationRequestSchema,
  ValidationCancelSchema,
  ListConversationsSchema,
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
import { ValidationService } from './validation.service';

@RequireRole(Role.DEVELOPER)
@Controller()
export class ValidationController {
  constructor(private readonly validation: ValidationService) {}
  @Post('patch-applications/:id/validations')
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  request(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Body(zodBody(ValidationRequestSchema)) input: ReturnType<typeof ValidationRequestSchema.parse>,
  ) {
    return this.validation.request({ organizationId, userId: user.userId, traceId }, id, input);
  }
  @Get('patch-applications/:id/validations')
  list(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Query(zodQuery(ListConversationsSchema))
    query: ReturnType<typeof ListConversationsSchema.parse>,
  ) {
    return this.validation.list({ organizationId, userId: user.userId, traceId }, id, query);
  }
  @Get('validations/:id')
  get(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
  ) {
    return this.validation.get({ organizationId, userId: user.userId, traceId }, id);
  }
  @Get('validations/:id/steps')
  async steps(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
  ) {
    return {
      items: (await this.validation.get({ organizationId, userId: user.userId, traceId }, id))
        .steps,
    };
  }
  @Post('validations/:id/cancel')
  @HttpCode(200)
  cancel(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Body(zodBody(ValidationCancelSchema)) input: ReturnType<typeof ValidationCancelSchema.parse>,
  ) {
    return this.validation.cancel(
      { organizationId, userId: user.userId, traceId },
      id,
      input.requestId,
    );
  }
}
