import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GithubClientFactory } from './github-client.factory';
import { JwtTokenService } from './jwt.service';
import { TokenCryptoService } from './token-crypto.service';

/**
 * Global so the guards, TokenCryptoService and GithubClientFactory are available
 * everywhere without each feature module re-importing them. Secrets are supplied per
 * sign/verify call in JwtTokenService rather than registered here, because access and
 * refresh tokens use different keys.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, JwtTokenService, TokenCryptoService, GithubClientFactory],
  exports: [AuthService, JwtTokenService, TokenCryptoService, GithubClientFactory],
})
export class AuthModule {}
