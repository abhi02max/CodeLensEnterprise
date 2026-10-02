import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CreateConversationSchema,
  CreateConversationMessageSchema,
  GetConversationSchema,
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
import { CollaborationService } from './collaboration.service';

@ApiTags('collaboration')
@ApiBearerAuth('access-token')
@RequireRole(Role.DEVELOPER)
@Controller()
export class CollaborationController {
  constructor(private readonly collaboration: CollaborationService) {}

  @Post('review-sessions/:prId/conversations')
  @HttpCode(201)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('prId') prId: string,
    @Body(zodBody(CreateConversationSchema))
    input: ReturnType<typeof CreateConversationSchema.parse>,
  ) {
    return this.collaboration.create({ organizationId, userId: user.userId, traceId }, prId, input);
  }

  @Get('review-sessions/:prId/conversations')
  list(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('prId') prId: string,
    @Query(zodQuery(ListConversationsSchema))
    query: ReturnType<typeof ListConversationsSchema.parse>,
  ) {
    return this.collaboration.list({ organizationId, userId: user.userId, traceId }, prId, query);
  }

  @Get('conversations/:id')
  get(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Query(zodQuery(GetConversationSchema)) query: ReturnType<typeof GetConversationSchema.parse>,
  ) {
    return this.collaboration.get({ organizationId, userId: user.userId, traceId }, id, query);
  }

  @Post('conversations/:id/messages')
  @HttpCode(201)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  message(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Body(zodBody(CreateConversationMessageSchema))
    input: ReturnType<typeof CreateConversationMessageSchema.parse>,
  ) {
    return this.collaboration.message({ organizationId, userId: user.userId, traceId }, id, input);
  }
}
