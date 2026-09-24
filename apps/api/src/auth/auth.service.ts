import { Injectable, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import {
  AuditAction,
  BCRYPT_ROUNDS,
  DEFAULT_REVIEW_POLICY,
  Role,
  slugify,
  type AuthResponse,
  type OrganizationSummary,
  type PublicUser,
  type SessionResponse,
  type SignInInput,
  type SignUpInput,
} from '@codelens/shared';
import {
  assessScopes,
  buildAuthorizeUrl,
  createOAuthState,
  exchangeCodeForToken,
  GithubClient,
  verifyOAuthState,
} from '@codelens/github';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit-logs/audit.service';
import { JwtTokenService } from './jwt.service';
import { TokenCryptoService } from './token-crypto.service';

/**
 * Authentication and identity.
 *
 * Covers local credentials, GitHub OAuth, session refresh and organization
 * switching. Tenant membership is resolved here, so this is the one place that
 * decides which organization a session is scoped to — everything downstream trusts
 * the `orgId` claim.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtTokenService,
    private readonly crypto: TokenCryptoService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- local auth

  async signUp(
    input: SignUpInput,
    meta: { ipAddress: string | null; userAgent: string | null; traceId: string },
  ): Promise<AuthResponse> {
    // Cross-tenant by necessity: email uniqueness is global.
    const existing = await this.prisma.unscoped.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });

    if (existing) {
      // Deliberately explicit rather than a vague error. Email enumeration is a real
      // concern for consumer products, but this is a B2B tool where an admin invites
      // colleagues by email, and "account already exists, sign in instead" saves far
      // more support load than the enumeration risk costs.
      throw new ConflictError('An account with this email already exists', {
        field: 'email',
      });
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    // One transaction so a failure part-way cannot leave a user with no organization,
    // which would be an account that can authenticate but do nothing.
    const result = await this.prisma.unscoped.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          // Email verification is not wired up yet, so accounts are usable
          // immediately. Explicit rather than implicit so the gap is visible.
          emailVerifiedAt: new Date(),
        },
      });

      if (input.inviteToken) {
        const membership = await this.acceptInvite(tx, user.id, input.inviteToken);
        return { user, organizationId: membership.organizationId, role: membership.role };
      }

      const organizationName = input.organizationName ?? `${input.name}'s workspace`;
      const organization = await this.createOrganizationFor(tx, user.id, organizationName);

      return { user, organizationId: organization.id, role: Role.OWNER };
    });

    await this.audit.record({
      organizationId: result.organizationId,
      action: AuditAction.USER_SIGNED_UP,
      actorId: result.user.id,
      resourceType: 'User',
      resourceId: result.user.id,
      description: `${result.user.email} signed up`,
      ...meta,
    });

    return this.buildAuthResponse(result.user.id, result.organizationId);
  }

  async signIn(
    input: SignInInput,
    meta: { ipAddress: string | null; userAgent: string | null; traceId: string },
  ): Promise<AuthResponse> {
    const user = await this.prisma.unscoped.user.findUnique({
      where: { email: input.email },
      select: { id: true, passwordHash: true, email: true },
    });

    // Compare against a dummy hash when the user does not exist so the response time
    // does not reveal whether the email is registered. Without this, sign-in latency
    // is a reliable account-enumeration oracle.
    const hash = user?.passwordHash ?? DUMMY_BCRYPT_HASH;
    const valid = await bcrypt.compare(input.password, hash);

    if (!user || !user.passwordHash || !valid) {
      throw new UnauthorizedError('Incorrect email or password');
    }

    const membership = await this.resolveDefaultMembership(user.id);

    await this.prisma.unscoped.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });

    if (membership) {
      await this.audit.record({
        organizationId: membership.organizationId,
        action: AuditAction.USER_LOGGED_IN,
        actorId: user.id,
        resourceType: 'User',
        resourceId: user.id,
        description: `${user.email} signed in`,
        ...meta,
      });
    }

    return this.buildAuthResponse(user.id, membership?.organizationId ?? null);
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * Authorization claims are re-read from the database rather than copied from the
   * old token, so a membership revoked mid-session cannot be carried forward by
   * refreshing. `tokenGeneration` is also re-checked, which is what makes a password
   * change invalidate existing sessions.
   */
  async refresh(refreshToken: string): Promise<AuthResponse> {
    const payload = await this.jwt.verifyRefresh(refreshToken);

    const user = await this.prisma.unscoped.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, tokenGeneration: true },
    });

    if (!user) {
      throw new UnauthorizedError('Account no longer exists');
    }

    if (user.tokenGeneration !== payload.gen) {
      throw new UnauthorizedError(
        'This session was revoked, most likely by a password change. Sign in again.',
      );
    }

    const membership = await this.resolveDefaultMembership(user.id);
    return this.buildAuthResponse(user.id, membership?.organizationId ?? null);
  }

  /**
   * Revoke every session for a user by bumping the token generation.
   *
   * Chosen over a token denylist because it needs no extra storage and no expiry
   * sweeping, and because it is impossible to get subtly wrong: there is one counter
   * and tokens either match it or they do not.
   */
  async signOutEverywhere(
    userId: string,
    meta: { ipAddress: string | null; userAgent: string | null; traceId: string },
    organizationId: string | null,
  ): Promise<void> {
    const user = await this.prisma.unscoped.user.update({
      where: { id: userId },
      data: { tokenGeneration: { increment: 1 } },
      select: { email: true },
    });

    if (organizationId) {
      await this.audit.record({
        organizationId,
        action: AuditAction.USER_LOGGED_OUT,
        actorId: userId,
        resourceType: 'User',
        resourceId: userId,
        description: `${user.email} signed out of all sessions`,
        ...meta,
      });
    }
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.unscoped.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (!user?.passwordHash) {
      throw new ValidationError(
        'This account has no password set. It was created through GitHub sign-in.',
        { currentPassword: ['No password is set for this account'] },
      );
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      throw new ValidationError('Current password is incorrect', {
        currentPassword: ['Incorrect password'],
      });
    }

    // Bumping the generation signs out every other device, which is the expected
    // behaviour after a password change and the main reason to have the counter.
    await this.prisma.unscoped.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
        tokenGeneration: { increment: 1 },
      },
    });
  }

  // ---------------------------------------------------------------- github oauth

  /**
   * Build the GitHub authorize URL.
   *
   * The `state` parameter is an HMAC-signed payload rather than a database row, so the
   * callback is stateless while still being CSRF-protected and time-limited. It also
   * carries the id of an already-authenticated user, which is how "connect GitHub to
   * my existing account" is distinguished from "sign in with GitHub".
   */
  startGithubFlow(params: { linkToUserId?: string; redirectTo?: string }): { url: string } {
    const github = this.config.github;

    if (!github.configured) {
      throw new ValidationError(
        'GitHub sign-in is not configured on this deployment. Set GITHUB_CLIENT_ID and ' +
          'GITHUB_CLIENT_SECRET.',
      );
    }

    const state = createOAuthState(this.config.jwtSecret, {
      ...(params.linkToUserId ? { linkToUserId: params.linkToUserId } : {}),
      ...(params.redirectTo ? { redirectTo: params.redirectTo } : {}),
    });

    return {
      url: buildAuthorizeUrl(
        {
          clientId: github.clientId,
          clientSecret: github.clientSecret,
          callbackUrl: github.callbackUrl,
          scopes: github.scopes,
        },
        state,
      ),
    };
  }

  /**
   * Handle the OAuth callback.
   *
   * Three distinct outcomes are handled: linking to an authenticated account, signing
   * in an account whose GitHub identity is already linked, and creating a new account.
   * Matching on GitHub's numeric account id rather than login is deliberate — logins
   * are renameable and reusable, ids are not.
   */
  async completeGithubFlow(
    params: { code: string; state: string },
    meta: { ipAddress: string | null; userAgent: string | null; traceId: string },
  ): Promise<AuthResponse & { redirectTo: string | null }> {
    const github = this.config.github;

    if (!github.configured) {
      throw new ValidationError('GitHub sign-in is not configured on this deployment');
    }

    const verifiedState = verifyOAuthState(params.state, this.config.jwtSecret);
    const linkToUserId =
      typeof verifiedState.linkToUserId === 'string' ? verifiedState.linkToUserId : null;
    const redirectTo =
      typeof verifiedState.redirectTo === 'string' ? verifiedState.redirectTo : null;

    const tokenResponse = await exchangeCodeForToken(
      {
        clientId: github.clientId,
        clientSecret: github.clientSecret,
        callbackUrl: github.callbackUrl,
        scopes: github.scopes,
      },
      params.code,
    );

    const scopeAssessment = assessScopes(tokenResponse.scopes);

    if (scopeAssessment.missing.length > 0) {
      this.logger.warn(
        `GitHub connection granted fewer scopes than requested; missing: ${scopeAssessment.missing.join(', ')}`,
      );
    }

    const profile = await new GithubClient({
      accessToken: tokenResponse.accessToken,
    }).getAuthenticatedUser();

    const encryptedAccess = this.crypto.encrypt(tokenResponse.accessToken);
    const encryptedRefresh = tokenResponse.refreshToken
      ? this.crypto.encrypt(tokenResponse.refreshToken)
      : null;

    const accountData = {
      provider: 'github',
      providerAccountId: String(profile.githubId),
      providerLogin: profile.login,
      accessTokenEncrypted: encryptedAccess,
      refreshTokenEncrypted: encryptedRefresh,
      tokenExpiresAt: tokenResponse.expiresAt,
      scopes: tokenResponse.scopes,
    };

    const existingAccount = await this.prisma.unscoped.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: 'github',
          providerAccountId: String(profile.githubId),
        },
      },
      select: { userId: true },
    });

    let userId: string;

    if (linkToUserId) {
      // Linking to an authenticated account. Refuse if this GitHub identity already
      // belongs to someone else, otherwise two users would share one token and the
      // audit trail would attribute actions to the wrong person.
      if (existingAccount && existingAccount.userId !== linkToUserId) {
        throw new ConflictError(
          'This GitHub account is already connected to a different CodeLens account',
        );
      }

      userId = linkToUserId;
      await this.upsertAccount(userId, accountData);
    } else if (existingAccount) {
      userId = existingAccount.userId;
      await this.upsertAccount(userId, accountData);
    } else {
      // New account. GitHub is the only path that can create a user without a
      // password, hence passwordHash stays null and changePassword rejects later.
      if (!profile.email) {
        throw new ValidationError(
          'Your GitHub account has no accessible email address. Make an email public, ' +
            'or grant the user:email scope, or sign up with email and password instead.',
        );
      }

      const existingByEmail = await this.prisma.unscoped.user.findUnique({
        where: { email: profile.email },
        select: { id: true },
      });

      if (existingByEmail) {
        // Same person, previously registered with a password. Link rather than
        // creating a duplicate account for the same human.
        userId = existingByEmail.id;
        await this.upsertAccount(userId, accountData);
      } else {
        const created = await this.prisma.unscoped.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              email: profile.email!,
              name: profile.name ?? profile.login,
              avatarUrl: profile.avatarUrl,
              emailVerifiedAt: new Date(),
            },
          });

          await tx.account.create({ data: { ...accountData, userId: user.id } });
          await this.createOrganizationFor(tx, user.id, `${profile.login}'s workspace`);

          return user;
        });

        userId = created.id;
      }
    }

    const membership = await this.resolveDefaultMembership(userId);

    if (membership) {
      await this.audit.record({
        organizationId: membership.organizationId,
        action: AuditAction.GITHUB_CONNECTED,
        actorId: userId,
        resourceType: 'Account',
        resourceId: String(profile.githubId),
        description:
          `Connected GitHub account @${profile.login}` +
          (scopeAssessment.canReadPrivateRepos
            ? ' with private repository access'
            : ' with public repository access only'),
        metadata: {
          login: profile.login,
          scopes: tokenResponse.scopes,
          canReadPrivateRepos: scopeAssessment.canReadPrivateRepos,
        },
        ...meta,
      });
    }

    const auth = await this.buildAuthResponse(userId, membership?.organizationId ?? null);
    return { ...auth, redirectTo };
  }

  async disconnectGithub(userId: string, organizationId: string | null): Promise<void> {
    await this.prisma.unscoped.account.deleteMany({
      where: { userId, provider: 'github' },
    });

    if (organizationId) {
      await this.audit.record({
        organizationId,
        action: AuditAction.GITHUB_DISCONNECTED,
        actorId: userId,
        resourceType: 'Account',
        resourceId: userId,
        description: 'Disconnected GitHub account',
        ipAddress: null,
        userAgent: null,
        traceId: null,
      });
    }
  }

  // ---------------------------------------------------------------- sessions

  async getSession(userId: string, activeOrganizationId: string | null): Promise<SessionResponse> {
    const user = await this.prisma.unscoped.user.findUnique({
      where: { id: userId },
      include: {
        accounts: { where: { provider: 'github' }, select: { providerLogin: true } },
        memberships: {
          include: { organization: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!user) throw new NotFoundError('User', userId);

    const organizations: OrganizationSummary[] = user.memberships.map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      role: membership.role as Role,
    }));

    // Fall back to the first membership if the token's org is stale, e.g. the user was
    // removed from that organization since the token was issued.
    const active =
      activeOrganizationId && organizations.some((org) => org.id === activeOrganizationId)
        ? activeOrganizationId
        : (organizations[0]?.id ?? null);

    return {
      user: toPublicUser(user, user.accounts[0]?.providerLogin ?? null),
      organizations,
      activeOrganizationId: active,
    };
  }

  /** Re-issue tokens scoped to a different organization the user belongs to. */
  async switchOrganization(userId: string, organizationId: string): Promise<AuthResponse> {
    const membership = await this.prisma.unscoped.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { organizationId: true },
    });

    if (!membership) {
      // 403 rather than 404: revealing whether an organization exists would leak
      // tenant names to anyone who can guess an id.
      throw new ForbiddenError('You are not a member of that organization');
    }

    return this.buildAuthResponse(userId, organizationId);
  }

  // ---------------------------------------------------------------- internals

  private async buildAuthResponse(
    userId: string,
    organizationId: string | null,
  ): Promise<AuthResponse> {
    const user = await this.prisma.unscoped.user.findUnique({
      where: { id: userId },
      include: {
        accounts: { where: { provider: 'github' }, select: { providerLogin: true } },
        memberships: {
          include: { organization: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!user) throw new NotFoundError('User', userId);

    const organizations: OrganizationSummary[] = user.memberships.map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      role: membership.role as Role,
    }));

    const activeOrganizationId =
      organizationId && organizations.some((org) => org.id === organizationId)
        ? organizationId
        : (organizations[0]?.id ?? null);

    const role = activeOrganizationId
      ? (organizations.find((org) => org.id === activeOrganizationId)?.role ?? null)
      : null;

    const tokens = await this.jwt.issue({
      userId: user.id,
      email: user.email,
      organizationId: activeOrganizationId,
      role,
      tokenGeneration: user.tokenGeneration,
    });

    return {
      user: toPublicUser(user, user.accounts[0]?.providerLogin ?? null),
      organizations,
      activeOrganizationId,
      tokens,
    };
  }

  /** The organization a session defaults to: the oldest membership. */
  private async resolveDefaultMembership(
    userId: string,
  ): Promise<{ organizationId: string; role: Role } | null> {
    const membership = await this.prisma.unscoped.membership.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { organizationId: true, role: true },
    });

    return membership ? { organizationId: membership.organizationId, role: membership.role as Role } : null;
  }

  private async upsertAccount(
    userId: string,
    data: {
      provider: string;
      providerAccountId: string;
      providerLogin: string;
      accessTokenEncrypted: string;
      refreshTokenEncrypted: string | null;
      tokenExpiresAt: Date | null;
      scopes: string[];
    },
  ): Promise<void> {
    await this.prisma.unscoped.account.upsert({
      where: {
        provider_providerAccountId: {
          provider: data.provider,
          providerAccountId: data.providerAccountId,
        },
      },
      create: { ...data, userId },
      // Re-authorizing replaces the token and scopes. Scopes can shrink if the user
      // declines a permission on a later authorization, so they are overwritten
      // rather than merged.
      update: {
        providerLogin: data.providerLogin,
        accessTokenEncrypted: data.accessTokenEncrypted,
        refreshTokenEncrypted: data.refreshTokenEncrypted,
        tokenExpiresAt: data.tokenExpiresAt,
        scopes: data.scopes,
        userId,
      },
    });
  }

  /**
   * Create an organization with its default policy and AI settings.
   *
   * Policy and settings rows are created eagerly rather than lazily so every code
   * path downstream can assume they exist, instead of each one handling a null policy.
   */
  private async createOrganizationFor(
    tx: PrismaTransaction,
    userId: string,
    name: string,
  ): Promise<{ id: string }> {
    const slug = await this.uniqueSlug(tx, slugify(name) || 'workspace');

    const organization = await tx.organization.create({
      data: {
        name,
        slug,
        memberships: { create: { userId, role: Role.OWNER } },
        policy: {
          create: {
            blockingSeverity: DEFAULT_REVIEW_POLICY.blockingSeverity,
            riskScoreGate: DEFAULT_REVIEW_POLICY.riskScoreGate,
            requireTestsForCodeChanges: DEFAULT_REVIEW_POLICY.requireTestsForCodeChanges,
            minApprovals: DEFAULT_REVIEW_POLICY.minApprovals,
            sensitiveFlagsRequireTwoApprovals:
              DEFAULT_REVIEW_POLICY.sensitiveFlagsRequireTwoApprovals,
            autoPostGithubComment: DEFAULT_REVIEW_POLICY.autoPostGithubComment,
            blockOnSecretDetection: DEFAULT_REVIEW_POLICY.blockOnSecretDetection,
            githubCommentMinRole: DEFAULT_REVIEW_POLICY.githubCommentMinRole,
            checklist: [...DEFAULT_REVIEW_POLICY.checklist],
          },
        },
        aiSettings: {
          create: {
            provider: this.config.ai.provider.toUpperCase() as 'OPENAI' | 'ANTHROPIC' | 'OPENROUTER',
            model: this.config.ai.model,
            temperature: this.config.ai.temperature,
            maxOutputTokens: this.config.ai.maxOutputTokens,
            maxCostCentsPerRun: this.config.ai.maxCostCentsPerRun,
            embeddingProvider: this.config.rag.embeddingProvider,
            embeddingModel: this.config.rag.embeddingModel,
          },
        },
      },
      select: { id: true },
    });

    return organization;
  }

  private async uniqueSlug(tx: PrismaTransaction, base: string): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await tx.organization.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });

      if (!taken) return candidate;
    }

    // Give up on readable slugs rather than looping; collisions this deep mean the
    // base is extremely common.
    return `${base}-${Date.now().toString(36)}`;
  }

  private async acceptInvite(
    tx: PrismaTransaction,
    userId: string,
    inviteToken: string,
  ): Promise<{ organizationId: string; role: Role }> {
    const invite = await tx.invite.findUnique({
      where: { tokenHash: this.crypto.hashToken(inviteToken) },
    });

    if (!invite) throw new ValidationError('This invitation link is not valid');
    if (invite.acceptedAt) throw new ValidationError('This invitation has already been used');
    if (invite.revokedAt) throw new ValidationError('This invitation was revoked');
    if (invite.expiresAt < new Date()) throw new ValidationError('This invitation has expired');

    await tx.membership.create({
      data: { userId, organizationId: invite.organizationId, role: invite.role },
    });

    if (invite.teamIds.length > 0) {
      await tx.teamMember.createMany({
        data: invite.teamIds.map((teamId) => ({ teamId, userId })),
        skipDuplicates: true,
      });
    }

    await tx.invite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    return { organizationId: invite.organizationId, role: invite.role as Role };
  }
}

/**
 * A bcrypt hash of a value nobody can supply, used to equalise sign-in timing for
 * unknown emails. The cost factor must match BCRYPT_ROUNDS or the timing difference
 * reappears.
 */
const DUMMY_BCRYPT_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.wnaML7dRQRhFqbFdBNAcKlbTWMmaEHG';

type PrismaTransaction = Parameters<
  Parameters<PrismaService['unscoped']['$transaction']>[0]
>[0];

function toPublicUser(
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    createdAt: Date;
  },
  githubLogin: string | null,
): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    githubLogin,
    githubConnected: githubLogin !== null,
    createdAt: user.createdAt.toISOString(),
  };
}
