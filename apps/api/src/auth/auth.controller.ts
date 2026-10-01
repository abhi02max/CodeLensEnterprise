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
import { OAuthStateService, OAUTH_BROWSER_COOKIE, OAUTH_TTL_SECONDS } from './oauth-state.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly jwt: JwtTokenService,
    private readonly config: AppConfigService,
    private readonly oauthState: OAuthStateService,
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
   * Public sign-in entry point. Explicit link mode requires a valid local refresh
   * session; an optional bearer token must describe that same identity.
   */
  @Public()
  @Get('github')
  @ApiOperation({ summary: 'Redirect to GitHub to sign in or connect an account' })
  async github(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Query('mode') mode: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const header = request.headers.authorization;
    const accessToken = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
    const { url, browser } = await this.auth.startGithubFlow({
      link: mode === 'link',
      refreshToken: request.cookies?.[REFRESH_TOKEN_COOKIE],
      ...(accessToken ? { accessToken } : {}),
    });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.cookie(OAUTH_BROWSER_COOKIE, browser, {
      httpOnly: true, secure: this.config.isProduction, sameSite: 'lax',
      path: '/api/v1/auth/github', maxAge: OAUTH_TTL_SECONDS * 1000,
    });
    response.redirect(url);
  }

  /**
   * GitHub OAuth callback.
   *
   * Redirects to the web app rather than returning JSON, because the browser arrives
   * here by top-level navigation. Session recovery uses only the HttpOnly refresh
   * cookie; neither access tokens nor upstream error details belong in redirect URLs.
   */
  @Public()
  @Get('github/callback')
  @ApiExcludeEndpoint()
  async githubCallback(
    @Req() request: Request,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @RequestMeta() meta: { ipAddress: string | null; userAgent: string | null },
    @TraceId() traceId: string,
    @Res() response: Response,
  ): Promise<void> {
    const webUrl = this.config.webUrl;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.clearCookie(OAUTH_BROWSER_COOKIE, { path: '/api/v1/auth/github' });
    let consumed = false;
    try {
      const context = await this.oauthState.consume(state, request.cookies?.[OAUTH_BROWSER_COOKIE], request.cookies?.[REFRESH_TOKEN_COOKIE]);
      consumed = true;
      if (error) {
        response.redirect(`${webUrl}/auth/callback?oauth=denied`);
        return;
      }
      if (!code) throw new UnauthorizedError('Incomplete GitHub callback');
      const result = await this.auth.completeGithubFlow({ code, context }, { ...meta, traceId });

      response.cookie(
        REFRESH_TOKEN_COOKIE,
        result.tokens.refreshToken,
        this.jwt.refreshCookieOptions(),
      );

      response.redirect(`${webUrl}/auth/callback?oauth=connected`);
    } catch {
      response.redirect(`${webUrl}/auth/callback?oauth=${consumed ? 'failed' : 'invalid'}`);
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
