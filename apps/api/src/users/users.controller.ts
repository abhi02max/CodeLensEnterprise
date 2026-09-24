import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UpdateProfileSchema, type PublicUser } from '@codelens/shared';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { NotFoundError } from '../common/errors';
import { zodBody } from '../common/zod-validation.pipe';
import { GithubClientFactory } from '../auth/github-client.factory';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Current-user profile.
 *
 * Deliberately offers no "read another user" endpoint. Member details are exposed
 * through `/organizations/current/members`, which is tenant-scoped; a `/users/:id`
 * route would be an easy way to enumerate accounts across organizations.
 */
@ApiTags('users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClientFactory,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Current user profile and GitHub connection status' })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<
    PublicUser & {
      timezone: string;
      githubRateLimit: { limit: number; remaining: number; resetAt: string; used: number } | null;
      githubScopes: string[];
    }
  > {
    const record = await this.prisma.unscoped.user.findUnique({
      where: { id: user.userId },
      include: {
        accounts: {
          where: { provider: 'github' },
          select: { providerLogin: true, scopes: true },
        },
      },
    });

    if (!record) throw new NotFoundError('User', user.userId);

    const account = record.accounts[0];

    return {
      id: record.id,
      email: record.email,
      name: record.name,
      avatarUrl: record.avatarUrl,
      githubLogin: account?.providerLogin ?? null,
      githubConnected: Boolean(account),
      createdAt: record.createdAt.toISOString(),
      timezone: record.timezone,
      // Surfaced so the UI can warn before a large indexing run exhausts the hourly
      // budget, rather than failing partway through.
      githubRateLimit: await this.github.rateLimitFor(user.userId),
      githubScopes: account?.scopes ?? [],
    };
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the current user profile' })
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(UpdateProfileSchema)) body: ReturnType<typeof UpdateProfileSchema.parse>,
  ): Promise<PublicUser> {
    const updated = await this.prisma.unscoped.user.update({
      where: { id: user.userId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      },
      include: { accounts: { where: { provider: 'github' }, select: { providerLogin: true } } },
    });

    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      avatarUrl: updated.avatarUrl,
      githubLogin: updated.accounts[0]?.providerLogin ?? null,
      githubConnected: updated.accounts.length > 0,
      createdAt: updated.createdAt.toISOString(),
    };
  }
}
