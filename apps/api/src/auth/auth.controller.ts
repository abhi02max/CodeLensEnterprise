import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  ChangePasswordSchema,
  REFRESH_TOKEN_COOKIE,
  SignInSchema,
  SignUpSchema,
  SwitchOrganizationSchema,
  type AuthResponse,
} from '@codelens/shared';
import {
  CurrentUser,
  Public,
  RequestMeta,
  TraceId,
  type AuthenticatedUser,
} from '../common/decorators';
import { UnauthorizedError } from '../common/errors';
import { zodBody } from '../common/zod-validation.pipe';
import { AppConfigService } from '../config/app-config.service';
import { AuthService } from './auth.service';
import { JwtTokenService } from './jwt.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly jwt: JwtTokenService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Sign up.
   *
   * Rate-limited hard: signup creates an organization and is therefore the most
   * expensive unauthenticated endpoint in the API.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('signup')
  @ApiOperation({ summary: 'Create an account, optionally with a new organization' })
  async signUp(
    @Body(zodBody(SignUpSchema)) body: ReturnType<typeof SignUpSchema.parse>,
    @RequestMeta() meta: { ipAddress: string | null; userAgent: string | null },
    @TraceId() traceId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.signUp(body, { ...meta, traceId });
    return this.withRefreshCookie(result, response);
  }

  /**
   * Sign in.
   *
   * Throttled to blunt credential stuffing. The limit is per IP, which is imperfect
   * behind a shared NAT but is the only signal available before authentication.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('signin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  async signIn(
    @Body(zodBody(SignInSchema)) body: ReturnType<typeof SignInSchema.parse>,
    @RequestMeta() meta: { ipAddress: string | null; userAgent: string | null },
    @TraceId() traceId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.signIn(body, { ...meta, traceId });
    return this.withRefreshCookie(result, response);
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * Accepts the token from the httpOnly cookie, falling back to the body so a
   * non-browser client (CLI, CI) can refresh without cookie handling.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair' })
  async refresh(
    @Req() request: Request,
    @Body() body: { refreshToken?: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    const cookies = (request.cookies ?? {}) as Record<string, string | undefined>;
    const token = cookies[REFRESH_TOKEN_COOKIE] ?? body?.refreshToken;

    if (!token) {
      throw new UnauthorizedError('No refresh token was supplied');
    }

    const result = await this.auth.refresh(token);
    return this.withRefreshCookie(result, response);
  }

  @Get('session')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Current user, memberships and active organization' })
  session(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.getSession(user.userId, user.organizationId);
  }

  /** Re-issue tokens scoped to a different organization. */
  @Post('switch-organization')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Switch the active organization for this session' })
  async switchOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(SwitchOrganizationSchema))
    body: ReturnType<typeof SwitchOrganizationSchema.parse>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.switchOrganization(user.userId, body.organizationId);
    return this.withRefreshCookie(result, response);
  }

  /**
   * Sign out of every session.
   *
   * Increments the token generation, so this is genuinely global rather than just
   * clearing the local cookie.
   */
  @Post('signout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Revoke all sessions for the current user' })
  async signOut(
    @CurrentUser() user: AuthenticatedUser,
    @RequestMeta() meta: { ipAddress: string | null; userAgent: string | null },
    @TraceId() traceId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.signOutEverywhere(user.userId, { ...meta, traceId }, user.organizationId);
    response.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Change password; revokes all other sessions' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(ChangePasswordSchema)) body: ReturnType<typeof ChangePasswordSchema.parse>,
  ): Promise<void> {
    await this.auth.changePassword(user.userId, body.currentPassword, body.newPassword);
  }

  // ---------------------------------------------------------------- github oauth

  /**
   * Begin the GitHub OAuth flow.
   *
   * Public, because it is also the sign-in entry point. When called with a valid
   * bearer token the flow instead links GitHub to that existing account, which is how
   * "connect GitHub" works from settings.
   */
  @Public()
  @Get('github')
  @ApiOperation({ summary: 'Redirect to GitHub to sign in or connect an account' })
  async github(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Query('redirectTo') redirectTo: string | undefined,
    @Query('mode') mode: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    // The global guard skipped this route, so the token is parsed manually to decide
    // between sign-in and link.
    let linkToUserId: string | undefined;

    if (mode === 'link') {
      const header = request.headers.authorization;
      const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;

      if (token) {
        try {
          const payload = await this.jwt.verifyAccess(token);
          linkToUserId = payload.sub;
        } catch {
          // Fall through to plain sign-in rather than failing: the user may simply
          // have an expired token, and signing them in is a reasonable outcome.
        }
      }
    }

    const { url } = this.auth.startGithubFlow({
      ...(linkToUserId ? { linkToUserId } : {}),
      ...(redirectTo ? { redirectTo } : {}),
    });

    response.redirect(url);
  }

  /**
   * GitHub OAuth callback.
   *
   * Redirects to the web app rather than returning JSON, because the browser arrives
   * here by top-level navigation. The access token is passed in the URL fragment: a
   * fragment is never sent to the server and never appears in access logs or a
   * `Referer` header, unlike a query parameter. The refresh token goes in an httpOnly
   * cookie and never touches the URL at all.
   */
  @Public()
  @Get('github/callback')
  @ApiExcludeEndpoint()
  async githubCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @RequestMeta() meta: { ipAddress: string | null; userAgent: string | null },
    @TraceId() traceId: string,
    @Res() response: Response,
  ): Promise<void> {
    const webUrl = this.config.webUrl;

    // The user declined authorization, or GitHub rejected the request.
    if (error) {
      const reason = encodeURIComponent(errorDescription ?? error);
      response.redirect(`${webUrl}/login?error=${reason}`);
      return;
    }

    if (!code || !state) {
      response.redirect(`${webUrl}/login?error=${encodeURIComponent('Incomplete OAuth callback')}`);
      return;
    }

    try {
      const result = await this.auth.completeGithubFlow({ code, state }, { ...meta, traceId });

      response.cookie(
        REFRESH_TOKEN_COOKIE,
        result.tokens.refreshToken,
        this.jwt.refreshCookieOptions(),
      );

      const target = safeRedirectTarget(result.redirectTo, webUrl);
      response.redirect(
        `${target}#access_token=${encodeURIComponent(result.tokens.accessToken)}` +
          `&expires_in=${result.tokens.expiresIn}`,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'GitHub sign-in failed';
      response.redirect(`${webUrl}/login?error=${encodeURIComponent(message)}`);
    }
  }

  @Delete('github')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Disconnect the GitHub account' })
  async disconnectGithub(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.auth.disconnectGithub(user.userId, user.organizationId);
  }

  /**
   * Set the refresh cookie and strip the refresh token from the JSON body.
   *
   * The refresh token exists only in the httpOnly cookie, so JavaScript on the page
   * cannot read it. Returning it in the body as well would undo that protection for no
   * benefit, since the browser sends the cookie automatically.
   */
  private withRefreshCookie(
    result: AuthResponse,
    response: Response,
  ): Omit<AuthResponse, 'tokens'> & { tokens: Omit<AuthResponse['tokens'], 'refreshToken'> } {
    response.cookie(
      REFRESH_TOKEN_COOKIE,
      result.tokens.refreshToken,
      this.jwt.refreshCookieOptions(),
    );

    const { refreshToken: _omitted, ...tokens } = result.tokens;
    return { ...result, tokens };
  }
}

/**
 * Constrain a post-login redirect to the configured web origin.
 *
 * Without this check the `redirectTo` parameter is an open redirect, and an open
 * redirect on an endpoint that appends an access token to the fragment hands that
 * token to any attacker-chosen host.
 */
function safeRedirectTarget(redirectTo: string | null, webUrl: string): string {
  if (!redirectTo) return `${webUrl}/auth/callback`;

  try {
    const candidate = new URL(redirectTo, webUrl);
    const allowed = new URL(webUrl);

    if (candidate.origin !== allowed.origin) return `${webUrl}/auth/callback`;
    return candidate.toString();
  } catch {
    return `${webUrl}/auth/callback`;
  }
}
