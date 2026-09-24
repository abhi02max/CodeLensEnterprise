import 'reflect-metadata';

import { Logger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_BASE_PATH } from '@codelens/shared';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { AppConfigService } from './config/app-config.service';

const LOG_LEVELS: Record<string, LogLevel[]> = {
  trace: ['verbose', 'debug', 'log', 'warn', 'error'],
  debug: ['debug', 'log', 'warn', 'error'],
  info: ['log', 'warn', 'error'],
  warn: ['warn', 'error'],
  error: ['error'],
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Buffered so configuration validation errors are emitted through the real
    // logger once it is configured, rather than as raw console output.
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);
  const logger = new Logger('Bootstrap');

  app.useLogger(LOG_LEVELS[config.logLevel] ?? LOG_LEVELS.info!);

  // ---- security headers
  app.use(
    helmet({
      // The API serves JSON, not HTML, so CSP would only restrict the Swagger UI.
      contentSecurityPolicy: config.isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(cookieParser());

  // ---- CORS
  //
  // Credentials are enabled because refresh tokens live in an httpOnly cookie, and
  // that requires an explicit origin allowlist: the spec forbids `*` with
  // credentials, and accepting arbitrary origins here would expose every
  // authenticated endpoint to any site the user visits.
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 86_400,
  });

  app.setGlobalPrefix(API_BASE_PATH.replace(/^\//, ''));
  app.useGlobalFilters(new AllExceptionsFilter(config.isProduction));

  // Flush in-flight work on SIGTERM instead of dropping it: an analysis job mid-run
  // should be allowed to finish or be requeued rather than vanish.
  app.enableShutdownHooks();

  // ---- OpenAPI
  if (!config.isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('CodeLens Enterprise API')
        .setDescription(
          'AI + ML assisted code review. Requests are authenticated with a bearer ' +
            'access token and scoped to the active organization.',
        )
        .setVersion('0.1.0')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'access-token',
        )
        .addTag('health', 'Service and dependency health')
        .addTag('auth', 'Authentication, GitHub OAuth and session management')
        .addTag('organizations', 'Organizations, teams, members and review policy')
        .addTag('repositories', 'Connected repositories and indexing')
        .addTag('pull-requests', 'Pull requests, diffs and analysis')
        .addTag('review-sessions', 'Review workspace, verdicts and share links')
        .addTag('comments', 'Review discussion threads')
        .addTag('ai-review', 'Generated AI review reports')
        .addTag('ml', 'Risk prediction and model metadata')
        .addTag('rag', 'Repository indexing and context retrieval')
        .addTag('jobs', 'Background job status')
        .addTag('audit-logs', 'Audit trail')
        .build(),
    );

    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
      customSiteTitle: 'CodeLens Enterprise API',
    });
  }

  await app.listen(config.port, '0.0.0.0');

  logger.log(`API listening on http://localhost:${config.port}${API_BASE_PATH}`);
  if (!config.isProduction) {
    logger.log(`OpenAPI docs at http://localhost:${config.port}/docs`);
  }
  logger.log(
    `env=${config.nodeEnv} ai=${config.ai.provider}/${config.ai.model} ` +
      `ai_configured=${config.ai.configured} ml=${config.ml.url} ` +
      `workers=${config.queue.runWorkersInApi}`,
  );
}

void bootstrap().catch((error: unknown) => {
  // Configuration and connection failures land here. Printed directly because the
  // Nest logger may not exist yet.
  console.error('\nFailed to start the CodeLens API:\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
