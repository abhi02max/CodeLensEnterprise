import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AnalysisModule } from './analysis/analysis.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { AuthModule } from './auth/auth.module';
import { McpToolsModule } from './mcp-tools/mcp-tools.module';
import { MlModule } from './ml/ml.module';
import { RagModule } from './rag/rag.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { TraceIdMiddleware } from './common/trace-id.middleware';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { PrismaModule } from './prisma/prisma.module';
import { PullRequestsModule } from './pull-requests/pull-requests.module';
import { QueuesModule } from './queues/queues.module';
import { WorkersModule } from './queues/workers.module';
import { RedisModule } from './redis/redis.module';
import { RepositoriesModule } from './repositories/repositories.module';
import { UsersModule } from './users/users.module';

/**
 * Root module.
 *
 * Guard order matters and is load-bearing:
 *
 *   1. ThrottlerGuard  — reject floods before doing any work, including crypto
 *   2. JwtAuthGuard    — authenticate, populating request.user
 *   3. RolesGuard      — authorize, which requires request.user to already exist
 *
 * Registering authentication globally means a new controller is protected by default
 * and must opt out with `@Public()`. The inverse arrangement makes a forgotten
 * decorator ship an open endpoint, which is not the kind of mistake that gets caught
 * in review.
 */
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RedisModule,
    // Producers before consumers: WorkersModule's processors resolve their queue options
    // from the queues registered here.
    QueuesModule,
    ThrottlerModule.forRoot([
      // Generous default: per-route @Throttle overrides tighten it for expensive or
      // sensitive operations. A global limit low enough to matter would break normal
      // dashboard use, which issues many reads per page.
      { name: 'default', ttl: 60_000, limit: 300 },
    ]),
    AuthModule,
    AuditLogsModule,
    OrganizationsModule,
    HealthModule,
    UsersModule,
    RepositoriesModule,
    PullRequestsModule,
    MlModule,
    RagModule,
    McpToolsModule,
    AnalysisModule,
    // Registered unconditionally. The processors declare `autorun: false` and only start
    // when RUN_WORKERS_IN_API is true, so importing this does not commit the API process to
    // doing background work — but it does guarantee the API and the standalone worker share
    // one definition of how each job runs.
    WorkersModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route, including public ones, so an unauthenticated failure is
    // still traceable in the logs.
    consumer.apply(TraceIdMiddleware).forRoutes('*');
  }
}
