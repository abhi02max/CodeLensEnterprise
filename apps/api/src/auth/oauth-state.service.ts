import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { createOAuthState, verifyOAuthState } from '@codelens/github';
import { AppConfigService } from '../config/app-config.service';
import { RedisService } from '../redis/redis.service';
import { UnauthorizedError } from '../common/errors';

export const OAUTH_BROWSER_COOKIE = 'codelens_oauth_browser';
export const OAUTH_TTL_SECONDS = 600;

export interface OAuthContext {
  linkToUserId: string | null;
  organizationId: string | null;
  tokenGeneration: number | null;
}

const CONSUME = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local entry = cjson.decode(raw)
if entry.binding ~= ARGV[1] then return nil end
redis.call('DEL', KEYS[1])
return raw`;

@Injectable()
export class OAuthStateService {
  constructor(private readonly redis: RedisService, private readonly config: AppConfigService) {}

  async issue(context: OAuthContext, refreshToken: string | undefined) {
    const browser = randomBytes(32).toString('base64url');
    const state = createOAuthState(this.config.jwtSecret);
    const { nonce } = verifyOAuthState(state, this.config.jwtSecret);
    // Unlike best-effort caching, OAuth state must fail closed when Redis is unavailable.
    const result = await this.redis.client.set(`oauth:github:${nonce}`, JSON.stringify({
      ...context, binding: binding(browser, refreshToken),
    }), 'EX', OAUTH_TTL_SECONDS, 'NX');
    if (result !== 'OK') throw new UnauthorizedError('Could not start GitHub connection');
    return { state, browser };
  }

  async consume(state: string | undefined, browser: string | undefined, refreshToken: string | undefined): Promise<OAuthContext> {
    if (!state || !browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) {
      throw new UnauthorizedError('Invalid or expired GitHub connection');
    }
    const { nonce } = verifyOAuthState(state, this.config.jwtSecret);
    const raw = await this.redis.client.eval(CONSUME, 1, `oauth:github:${nonce}`, binding(browser, refreshToken));
    if (typeof raw !== 'string') throw new UnauthorizedError('Invalid or expired GitHub connection');
    const entry = JSON.parse(raw) as OAuthContext;
    return { linkToUserId: entry.linkToUserId, organizationId: entry.organizationId, tokenGeneration: entry.tokenGeneration };
  }
}

function binding(browser: string, refreshToken: string | undefined): string {
  return createHash('sha256').update(JSON.stringify([browser, refreshToken ?? null])).digest('hex');
}
