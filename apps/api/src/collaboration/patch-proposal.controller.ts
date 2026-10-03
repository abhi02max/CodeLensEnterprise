import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  PatchDecisionSchema,
  PatchRevisionSchema,
  PatchFeedbackSchema,
  Role,
  ListConversationsSchema,
} from '@codelens/shared';
import {
  CurrentUser,
  OrgId,
  RequireRole,
  TraceId,
  type AuthenticatedUser,
} from '../common/decorators';
import { zodBody, zodQuery } from '../common/zod-validation.pipe';
import { PatchProposalService } from './patch-proposal.service';
import { CollaborationService } from './collaboration.service';
import { CollaborationExecutionService } from './collaboration-execution.service';

@RequireRole(Role.DEVELOPER)
@Controller()
export class PatchProposalController {
  constructor(
    private readonly patches: PatchProposalService,
    private readonly conversations: CollaborationService,
    private readonly execution: CollaborationExecutionService,
  ) {}
  @Get('patch-proposals/:id')
  get(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
  ) {
    return this.patches.get({ organizationId, userId: user.userId, traceId }, id);
  }
  @Get('conversations/:id/patch-proposals')
  list(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Query(zodQuery(ListConversationsSchema))
    query: ReturnType<typeof ListConversationsSchema.parse>,
  ) {
    return this.patches.list({ organizationId, userId: user.userId, traceId }, id, query);
  }
  @Get('collaboration-turns/:id/patch-proposals')
  listTurn(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Query(zodQuery(ListConversationsSchema))
    query: ReturnType<typeof ListConversationsSchema.parse>,
  ) {
    return this.patches.listTurn({ organizationId, userId: user.userId, traceId }, id, query);
  }
  @Post('patch-proposals/:id/decision')
  @HttpCode(200)
  decide(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Body(zodBody(PatchDecisionSchema)) input: ReturnType<typeof PatchDecisionSchema.parse>,
  ) {
    return this.patches.decide({ organizationId, userId: user.userId, traceId }, id, input);
  }
  @Post('patch-proposals/:id/revisions')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  revise(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Body(zodBody(PatchRevisionSchema)) input: ReturnType<typeof PatchRevisionSchema.parse>,
  ) {
    return this.patches.revise({ organizationId, userId: user.userId, traceId }, id, input);
  }
  @Post('patch-proposals/:id/revision-request')
  @HttpCode(202)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async feedback(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @Param('id') id: string,
    @Body(zodBody(PatchFeedbackSchema)) input: ReturnType<typeof PatchFeedbackSchema.parse>,
  ) {
    const actor = { organizationId, userId: user.userId, traceId };
    const proposal = await this.patches.get(actor, id);
    const result = await this.conversations.message(actor, proposal.conversationId, input, id);
    const execution = await this.execution.enqueue(actor, result.message.turn.id);
    return {
      ...result,
      message: { ...result.message, turn: { ...result.message.turn, status: execution.status } },
      aiExecutionAvailable: true,
    };
  }
}
