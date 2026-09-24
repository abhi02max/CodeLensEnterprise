import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  Role,
  ReviewVerdict,
  roleAtLeast,
  slugify,
  type CreateTeamInput,
  type InviteMemberInput,
  type MemberView,
  type OrganizationView,
  type PendingInviteView,
  type TeamView,
} from '@codelens/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TokenCryptoService } from '../auth/token-crypto.service';
import { AuditService } from '../audit-logs/audit.service';

/** Invites expire so a leaked link does not stay valid indefinitely. */
const INVITE_TTL_DAYS = 14;

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: TokenCryptoService,
    private readonly audit: AuditService,
  ) {}

  async overview(organizationId: string, userId: string): Promise<OrganizationView> {
    const org = await this.prisma.unscoped.organization.findUnique({
      where: { id: organizationId },
      include: {
        _count: { select: { memberships: true, repositories: true } },
        memberships: { where: { userId }, select: { role: true } },
      },
    });

    if (!org) throw new NotFoundError('Organization', organizationId);

    const myRole = org.memberships[0]?.role as Role | undefined;
    if (!myRole) throw new ForbiddenError('You are not a member of this organization');

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      avatarUrl: org.avatarUrl,
      plan: org.plan,
      memberCount: org._count.memberships,
      repositoryCount: org._count.repositories,
      createdAt: org.createdAt.toISOString(),
      myRole,
    };
  }

  async update(
    organizationId: string,
    patch: { name?: string; avatarUrl?: string | null },
    actorId: string,
  ): Promise<OrganizationView> {
    await this.prisma.unscoped.organization.update({
      where: { id: organizationId },
      data: patch,
    });

    await this.audit.record({
      organizationId,
      action: AuditAction.ORG_UPDATED,
      actorId,
      resourceType: 'Organization',
      resourceId: organizationId,
      description: `Organization settings updated`,
      metadata: patch as Record<string, unknown>,
    });

    return this.overview(organizationId, actorId);
  }

  // ---------------------------------------------------------------- members

  /**
   * Members with review throughput.
   *
   * The stats exist for a specific operational purpose: spotting the reviewer who has
   * become a bottleneck. `openAssignedReviews` counts open pull requests in the
   * organization this member has not yet reviewed at the current head SHA.
   */
  async listMembers(organizationId: string): Promise<MemberView[]> {
    const memberships = await this.prisma.unscoped.membership.findMany({
      where: { organizationId },
      include: {
        user: {
          include: {
            teamMemberships: {
              where: { team: { organizationId } },
              include: { team: { select: { id: true, name: true } } },
            },
          },
        },
      },
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    });

    const userIds = memberships.map((m) => m.userId);

    // Aggregated in three grouped queries rather than per-member queries, which would
    // be N+1 and visibly slow on a team of any size.
    const [reviewCounts, authoredCounts, openPrCount] = await Promise.all([
      this.prisma.unscoped.review.groupBy({
        by: ['reviewerId'],
        where: { organizationId, reviewerId: { in: userIds } },
        _count: { _all: true },
      }),
      this.prisma.unscoped.pullRequest.groupBy({
        by: ['authorUserId'],
        where: { organizationId, authorUserId: { in: userIds } },
        _count: { _all: true },
      }),
      this.prisma.unscoped.pullRequest.count({
        where: { organizationId, state: 'OPEN' },
      }),
    ]);

    const reviewedByUser = new Map(
      reviewCounts.map((row) => [row.reviewerId, row._count._all]),
    );
    const authoredByUser = new Map(
      authoredCounts
        .filter((row) => row.authorUserId !== null)
        .map((row) => [row.authorUserId as string, row._count._all]),
    );

    // Open PRs this member has reviewed at the current head, so the remainder is their
    // outstanding queue.
    const reviewedOpen = await this.prisma.unscoped.review.findMany({
      where: {
        organizationId,
        reviewerId: { in: userIds },
        pullRequest: { state: 'OPEN' },
      },
      select: { reviewerId: true, pullRequestId: true, headSha: true, pullRequest: { select: { headSha: true } } },
    });

    const currentlyReviewed = new Map<string, Set<string>>();
    for (const review of reviewedOpen) {
      // A review on a stale SHA does not count as done: the code changed since.
      if (review.headSha !== review.pullRequest.headSha) continue;

      const set = currentlyReviewed.get(review.reviewerId) ?? new Set<string>();
      set.add(review.pullRequestId);
      currentlyReviewed.set(review.reviewerId, set);
    }

    return memberships.map((membership) => ({
      id: membership.id,
      userId: membership.userId,
      email: membership.user.email,
      name: membership.user.name,
      avatarUrl: membership.user.avatarUrl,
      role: membership.role as Role,
      teams: membership.user.teamMemberships.map((tm) => tm.team),
      joinedAt: membership.createdAt.toISOString(),
      lastActiveAt: membership.user.lastActiveAt?.toISOString() ?? null,
      stats: {
        reviewsSubmitted: reviewedByUser.get(membership.userId) ?? 0,
        pullRequestsAuthored: authoredByUser.get(membership.userId) ?? 0,
        openAssignedReviews: Math.max(
          0,
          openPrCount - (currentlyReviewed.get(membership.userId)?.size ?? 0),
        ),
      },
    }));
  }

  async inviteMember(
    organizationId: string,
    input: InviteMemberInput,
    actorId: string,
    actorRole: Role,
  ): Promise<{ invite: PendingInviteView; token: string }> {
    // An admin must not be able to mint a role above their own.
    if (!roleAtLeast(actorRole, input.role)) {
      throw new ForbiddenError(
        `You cannot invite someone as ${input.role} because your own role is ${actorRole}.`,
      );
    }

    const existingUser = await this.prisma.unscoped.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });

    if (existingUser) {
      const alreadyMember = await this.prisma.unscoped.membership.findUnique({
        where: { userId_organizationId: { userId: existingUser.id, organizationId } },
        select: { id: true },
      });

      if (alreadyMember) {
        throw new ConflictError('That person is already a member of this organization');
      }
    }

    const { token, hash } = this.crypto.generateToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

    // Supersede any outstanding invite for the same address rather than accumulating
    // several valid links for one person.
    await this.prisma.unscoped.invite.updateMany({
      where: { organizationId, email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const invite = await this.prisma.unscoped.invite.create({
      data: {
        organizationId,
        email: input.email,
        role: input.role,
        tokenHash: hash,
        invitedById: actorId,
        teamIds: input.teamIds,
        expiresAt,
      },
      include: { invitedBy: { select: { name: true } } },
    });

    await this.audit.record({
      organizationId,
      action: AuditAction.MEMBER_INVITED,
      actorId,
      resourceType: 'Invite',
      resourceId: invite.id,
      description: `Invited ${input.email} as ${input.role}`,
      metadata: { email: input.email, role: input.role },
    });

    // The raw token is returned exactly once, for the caller to put in an email. Only
    // its hash is stored.
    return {
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role as Role,
        invitedByName: invite.invitedBy.name,
        createdAt: invite.createdAt.toISOString(),
        expiresAt: invite.expiresAt.toISOString(),
      },
      token,
    };
  }

  async listPendingInvites(organizationId: string): Promise<PendingInviteView[]> {
    const invites = await this.prisma.unscoped.invite.findMany({
      where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { invitedBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: invite.role as Role,
      invitedByName: invite.invitedBy.name,
      createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt.toISOString(),
    }));
  }

  async revokeInvite(organizationId: string, inviteId: string, actorId: string): Promise<void> {
    const invite = await this.prisma.unscoped.invite.findFirst({
      where: { id: inviteId, organizationId },
      select: { id: true, email: true },
    });

    if (!invite) throw new NotFoundError('Invite', inviteId);

    await this.prisma.unscoped.invite.update({
      where: { id: inviteId },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      organizationId,
      action: AuditAction.MEMBER_REMOVED,
      actorId,
      resourceType: 'Invite',
      resourceId: inviteId,
      description: `Revoked the invitation for ${invite.email}`,
    });
  }

  async updateMemberRole(
    organizationId: string,
    membershipId: string,
    role: Role,
    actorId: string,
    actorRole: Role,
  ): Promise<MemberView[]> {
    const membership = await this.prisma.unscoped.membership.findFirst({
      where: { id: membershipId, organizationId },
      include: { user: { select: { email: true } } },
    });

    if (!membership) throw new NotFoundError('Membership', membershipId);

    // Ownership transfer is a separate, deliberate flow. Allowing it here would let an
    // admin quietly promote themselves to owner.
    if (membership.role === Role.OWNER) {
      throw new ForbiddenError(
        'The owner role cannot be changed here. Transfer ownership explicitly instead.',
      );
    }

    if (!roleAtLeast(actorRole, role)) {
      throw new ForbiddenError(`You cannot grant a role higher than your own (${actorRole}).`);
    }

    if (membership.userId === actorId) {
      throw new ForbiddenError('You cannot change your own role');
    }

    await this.prisma.unscoped.membership.update({
      where: { id: membershipId },
      data: { role },
    });

    await this.audit.record({
      organizationId,
      action: AuditAction.MEMBER_ROLE_CHANGED,
      actorId,
      resourceType: 'Membership',
      resourceId: membershipId,
      description: `Changed ${membership.user.email} from ${membership.role} to ${role}`,
      metadata: { from: membership.role, to: role, email: membership.user.email },
    });

    return this.listMembers(organizationId);
  }

  async removeMember(
    organizationId: string,
    membershipId: string,
    actorId: string,
  ): Promise<void> {
    const membership = await this.prisma.unscoped.membership.findFirst({
      where: { id: membershipId, organizationId },
      include: { user: { select: { email: true } } },
    });

    if (!membership) throw new NotFoundError('Membership', membershipId);

    if (membership.role === Role.OWNER) {
      throw new ForbiddenError('The organization owner cannot be removed');
    }
    if (membership.userId === actorId) {
      throw new ForbiddenError('You cannot remove yourself from the organization');
    }

    await this.prisma.unscoped.membership.delete({ where: { id: membershipId } });

    await this.audit.record({
      organizationId,
      action: AuditAction.MEMBER_REMOVED,
      actorId,
      resourceType: 'Membership',
      resourceId: membershipId,
      description: `Removed ${membership.user.email} from the organization`,
      metadata: { email: membership.user.email },
    });
  }

  // ---------------------------------------------------------------- teams

  async listTeams(organizationId: string): Promise<TeamView[]> {
    const teams = await this.prisma.unscoped.team.findMany({
      where: { organizationId },
      include: { _count: { select: { members: true, repositories: true } } },
      orderBy: { name: 'asc' },
    });

    return teams.map((team) => ({
      id: team.id,
      name: team.name,
      description: team.description,
      memberCount: team._count.members,
      repositoryCount: team._count.repositories,
      createdAt: team.createdAt.toISOString(),
    }));
  }

  async createTeam(
    organizationId: string,
    input: CreateTeamInput,
    actorId: string,
  ): Promise<TeamView[]> {
    // Only add members who actually belong to this organization; an id from another
    // tenant must not become a team member.
    const validMemberIds = await this.filterOrganizationMembers(organizationId, input.memberIds);

    const team = await this.prisma.unscoped.team.create({
      data: {
        organizationId,
        name: input.name,
        description: input.description ?? null,
        members: { create: validMemberIds.map((userId) => ({ userId })) },
      },
    });

    await this.audit.record({
      organizationId,
      action: AuditAction.TEAM_CREATED,
      actorId,
      resourceType: 'Team',
      resourceId: team.id,
      description: `Created team "${team.name}" with ${validMemberIds.length} member(s)`,
    });

    return this.listTeams(organizationId);
  }

  async updateTeam(
    organizationId: string,
    teamId: string,
    input: Partial<CreateTeamInput>,
    actorId: string,
  ): Promise<TeamView[]> {
    const team = await this.prisma.unscoped.team.findFirst({
      where: { id: teamId, organizationId },
      select: { id: true, name: true },
    });

    if (!team) throw new NotFoundError('Team', teamId);

    await this.prisma.unscoped.$transaction(async (tx) => {
      await tx.team.update({
        where: { id: teamId },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        },
      });

      if (input.memberIds) {
        const validIds = await this.filterOrganizationMembers(organizationId, input.memberIds);

        // Replace the membership set rather than diffing: the payload is the desired
        // state, and a diff here would silently keep members the caller removed.
        await tx.teamMember.deleteMany({ where: { teamId } });
        if (validIds.length > 0) {
          await tx.teamMember.createMany({
            data: validIds.map((userId) => ({ teamId, userId })),
            skipDuplicates: true,
          });
        }
      }
    });

    await this.audit.record({
      organizationId,
      action: AuditAction.TEAM_UPDATED,
      actorId,
      resourceType: 'Team',
      resourceId: teamId,
      description: `Updated team "${input.name ?? team.name}"`,
    });

    return this.listTeams(organizationId);
  }

  async deleteTeam(organizationId: string, teamId: string, actorId: string): Promise<void> {
    const team = await this.prisma.unscoped.team.findFirst({
      where: { id: teamId, organizationId },
      select: { id: true, name: true },
    });

    if (!team) throw new NotFoundError('Team', teamId);

    await this.prisma.unscoped.team.delete({ where: { id: teamId } });

    await this.audit.record({
      organizationId,
      action: AuditAction.TEAM_UPDATED,
      actorId,
      resourceType: 'Team',
      resourceId: teamId,
      description: `Deleted team "${team.name}"`,
    });
  }

  /**
   * Restrict a set of user ids to actual members of the organization.
   *
   * Without this, a caller could add an arbitrary user id to a team and grant a
   * non-member visibility into the organization's repositories.
   */
  private async filterOrganizationMembers(
    organizationId: string,
    userIds: string[],
  ): Promise<string[]> {
    if (userIds.length === 0) return [];

    const memberships = await this.prisma.unscoped.membership.findMany({
      where: { organizationId, userId: { in: userIds } },
      select: { userId: true },
    });

    const valid = memberships.map((m) => m.userId);

    if (valid.length !== userIds.length) {
      this.logger.warn(
        `Dropped ${userIds.length - valid.length} user id(s) that are not members of ` +
          `organization ${organizationId}`,
      );
    }

    return valid;
  }

  /** Create an additional organization for an existing user, who becomes its owner. */
  async create(
    userId: string,
    input: { name: string; slug?: string },
  ): Promise<{ id: string; slug: string }> {
    const baseSlug = input.slug ?? slugify(input.name);

    if (!baseSlug) {
      throw new ValidationError('Organization name must contain at least one letter or number', {
        name: ['Cannot derive a URL slug from this name'],
      });
    }

    const taken = await this.prisma.unscoped.organization.findUnique({
      where: { slug: baseSlug },
      select: { id: true },
    });

    if (taken) {
      throw new ConflictError('That organization URL is already taken', { slug: baseSlug });
    }

    const org = await this.prisma.unscoped.organization.create({
      data: {
        name: input.name,
        slug: baseSlug,
        memberships: { create: { userId, role: Role.OWNER } },
        policy: { create: {} },
        aiSettings: { create: {} },
      },
      select: { id: true, slug: true },
    });

    await this.audit.record({
      organizationId: org.id,
      action: AuditAction.ORG_CREATED,
      actorId: userId,
      resourceType: 'Organization',
      resourceId: org.id,
      description: `Created organization "${input.name}"`,
    });

    return org;
  }

  /** Verdict totals used by the dashboard header. */
  async reviewLoad(organizationId: string): Promise<{
    approvals: number;
    changesRequested: number;
    needsDiscussion: number;
  }> {
    const grouped = await this.prisma.unscoped.review.groupBy({
      by: ['verdict'],
      where: { organizationId },
      _count: { _all: true },
    });

    const byVerdict = new Map(grouped.map((row) => [row.verdict, row._count._all]));

    return {
      approvals: byVerdict.get(ReviewVerdict.APPROVED) ?? 0,
      changesRequested: byVerdict.get(ReviewVerdict.CHANGES_REQUESTED) ?? 0,
      needsDiscussion: byVerdict.get(ReviewVerdict.NEEDS_DISCUSSION) ?? 0,
    };
  }
}
