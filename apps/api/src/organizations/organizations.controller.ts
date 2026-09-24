import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateOrganizationSchema,
  CreateTeamSchema,
  InviteMemberSchema,
  Role,
  UpdateAiSettingsSchema,
  UpdateMemberRoleSchema,
  UpdateOrganizationSchema,
  UpdateReviewPolicySchema,
  UpdateTeamSchema,
} from '@codelens/shared';
import {
  CurrentUser,
  OrgId,
  RequireRole,
  type AuthenticatedUser,
} from '../common/decorators';
import { ForbiddenError } from '../common/errors';
import { zodBody } from '../common/zod-validation.pipe';
import { OrganizationsService } from './organizations.service';
import { PolicyService } from './policy.service';

@ApiTags('organizations')
@ApiBearerAuth('access-token')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly policy: PolicyService,
  ) {}

  @Get('current')
  @ApiOperation({ summary: 'Active organization overview' })
  current(@OrgId() organizationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.organizations.overview(organizationId, user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an additional organization; the caller becomes owner' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(CreateOrganizationSchema))
    body: ReturnType<typeof CreateOrganizationSchema.parse>,
  ) {
    return this.organizations.create(user.userId, body);
  }

  @Patch('current')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'Update organization name or avatar' })
  update(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(UpdateOrganizationSchema))
    body: ReturnType<typeof UpdateOrganizationSchema.parse>,
  ) {
    return this.organizations.update(organizationId, body, user.userId);
  }

  // ---------------------------------------------------------------- members

  /** Readable by any member: knowing who can review your code is not privileged. */
  @Get('current/members')
  @ApiOperation({ summary: 'List members with review throughput statistics' })
  members(@OrgId() organizationId: string) {
    return this.organizations.listMembers(organizationId);
  }

  @Post('current/members/invite')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'Invite someone by email; returns the raw token once' })
  invite(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(InviteMemberSchema)) body: ReturnType<typeof InviteMemberSchema.parse>,
  ) {
    return this.organizations.inviteMember(
      organizationId,
      body,
      user.userId,
      requireRole(user),
    );
  }

  @Get('current/invites')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'List pending invitations' })
  invites(@OrgId() organizationId: string) {
    return this.organizations.listPendingInvites(organizationId);
  }

  @Delete('current/invites/:inviteId')
  @RequireRole(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  async revokeInvite(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('inviteId') inviteId: string,
  ): Promise<void> {
    await this.organizations.revokeInvite(organizationId, inviteId, user.userId);
  }

  @Patch('current/members/:membershipId')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: "Change a member's role" })
  updateMemberRole(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('membershipId') membershipId: string,
    @Body(zodBody(UpdateMemberRoleSchema)) body: ReturnType<typeof UpdateMemberRoleSchema.parse>,
  ) {
    return this.organizations.updateMemberRole(
      organizationId,
      membershipId,
      body.role,
      user.userId,
      requireRole(user),
    );
  }

  @Delete('current/members/:membershipId')
  @RequireRole(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member from the organization' })
  async removeMember(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('membershipId') membershipId: string,
  ): Promise<void> {
    await this.organizations.removeMember(organizationId, membershipId, user.userId);
  }

  // ---------------------------------------------------------------- teams

  @Get('current/teams')
  @ApiOperation({ summary: 'List teams' })
  teams(@OrgId() organizationId: string) {
    return this.organizations.listTeams(organizationId);
  }

  @Post('current/teams')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'Create a team' })
  createTeam(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(CreateTeamSchema)) body: ReturnType<typeof CreateTeamSchema.parse>,
  ) {
    return this.organizations.createTeam(organizationId, body, user.userId);
  }

  @Patch('current/teams/:teamId')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'Update a team; memberIds replaces the membership set' })
  updateTeam(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId') teamId: string,
    @Body(zodBody(UpdateTeamSchema)) body: ReturnType<typeof UpdateTeamSchema.parse>,
  ) {
    return this.organizations.updateTeam(organizationId, teamId, body, user.userId);
  }

  @Delete('current/teams/:teamId')
  @RequireRole(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a team' })
  async deleteTeam(
    @OrgId() organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId') teamId: string,
  ): Promise<void> {
    await this.organizations.deleteTeam(organizationId, teamId, user.userId);
  }

  // ---------------------------------------------------------------- policy

  /**
   * Readable by any member. Developers need to know what standard their pull request
   * will be held to, and hiding the checklist would be actively counterproductive.
   */
  @Get('current/policy')
  @ApiOperation({ summary: 'Effective review policy' })
  getPolicy(@OrgId() organizationId: string) {
    return this.policy.getPolicy(organizationId);
  }

  @Patch('current/policy')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'Update review policy; takes effect on the next analysis run' })
  updatePolicy(
    @OrgId() organizationId: string,
    @Body(zodBody(UpdateReviewPolicySchema))
    body: ReturnType<typeof UpdateReviewPolicySchema.parse>,
  ) {
    return this.policy.updatePolicy(organizationId, body);
  }

  @Get('current/ai-settings')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'AI provider and embedding settings' })
  getAiSettings(@OrgId() organizationId: string) {
    return this.policy.getAiSettings(organizationId);
  }

  @Patch('current/ai-settings')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'Update AI provider, model, cost ceiling and redaction settings' })
  updateAiSettings(
    @OrgId() organizationId: string,
    @Body(zodBody(UpdateAiSettingsSchema)) body: ReturnType<typeof UpdateAiSettingsSchema.parse>,
  ) {
    return this.policy.updateAiSettings(organizationId, body);
  }
}

/**
 * Narrow the nullable role on the JWT payload.
 *
 * RolesGuard has already established the caller holds at least the required role, so a
 * null here would mean the guard chain was bypassed.
 */
function requireRole(user: AuthenticatedUser): Role {
  if (!user.role) {
    throw new ForbiddenError('This action requires an active organization membership');
  }
  return user.role;
}
