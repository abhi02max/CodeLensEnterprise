import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Role, ValidationMlRequestSchema } from '@codelens/shared';
import {
  OrgId,
  CurrentUser,
  TraceId,
  RequireRole,
  type AuthenticatedUser,
} from '../common/decorators';
import { zodBody, zodQuery } from '../common/zod-validation.pipe';
import { ValidationMlService } from './validation-ml.service';
const querySchema = z.object({ comparisonId: z.string().uuid().optional() }).strict();
@RequireRole(Role.DEVELOPER)
@Controller('validations/:id/ml-assessment')
export class ValidationMlController {
  constructor(private readonly ml: ValidationMlService) {}
  @Post()
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  request(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Body(zodBody(ValidationMlRequestSchema)) input: { requestId: string },
  ) {
    return this.ml.request({ organizationId, userId: user.userId, traceId }, id, input);
  }
  @Get()
  async get(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Query(zodQuery(querySchema)) query: z.infer<typeof querySchema>,
    @Res() response: Response,
  ) {
    // Nest's default null return is an empty body, not the nullable JSON contract.
    return response.json(
      await this.ml.get({ organizationId, userId: user.userId, traceId }, id, query.comparisonId),
    );
  }
  @Post(':comparisonId/cancel')
  @HttpCode(200)
  cancel(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Param('comparisonId') comparisonId: string,
    @Body(zodBody(ValidationMlRequestSchema)) input: { requestId: string },
  ) {
    return this.ml.cancel(
      { organizationId, userId: user.userId, traceId },
      id,
      comparisonId,
      input.requestId,
    );
  }
}
