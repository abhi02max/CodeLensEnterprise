import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Role, ValidationAiRequestSchema } from '@codelens/shared';
import {
  OrgId,
  CurrentUser,
  TraceId,
  RequireRole,
  type AuthenticatedUser,
} from '../common/decorators';
import { zodBody, zodQuery } from '../common/zod-validation.pipe';
import { ValidationAiService } from './validation-ai.service';
const query = z.object({ reviewId: z.string().uuid().optional() }).strict();
@RequireRole(Role.DEVELOPER)
@Controller('validations/:id/ai-rereview')
export class ValidationAiController {
  constructor(private readonly ai: ValidationAiService) {}
  @Post()
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  request(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Body(zodBody(ValidationAiRequestSchema)) input: { requestId: string },
  ) {
    return this.ai.request({ organizationId, userId: user.userId, traceId }, id, input);
  }
  @Get()
  get(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Query(zodQuery(query)) input: z.infer<typeof query>,
  ) {
    return this.ai.get({ organizationId, userId: user.userId, traceId }, id, input.reviewId);
  }
  @Post(':reviewId/cancel')
  @HttpCode(200)
  cancel(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Param('reviewId') reviewId: string,
    @Body(zodBody(ValidationAiRequestSchema)) input: { requestId: string },
  ) {
    return this.ai.cancel(
      { organizationId, userId: user.userId, traceId },
      id,
      reviewId,
      input.requestId,
    );
  }
}
