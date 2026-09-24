import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.schema';

/**
 * Global configuration module.
 *
 * `.env` is read from the monorepo root rather than from apps/api, so one file
 * configures the API, the workers and the Prisma CLI. Keeping per-app env files in
 * sync is a reliable source of "works locally, broken in the worker" bugs.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Root .env first, then apps/api/.env as an optional local override.
      envFilePath: ['../../.env', '.env'],
      validate: validateEnv,
      expandVariables: true,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
