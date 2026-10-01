const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const requireApi = createRequire('/app/apps/api/package.json');
const { PrismaClient } = requireApi('@codelens/database');
const { OpenAiProvider, AnthropicProvider } = requireApi('@codelens/ai-agent');
const { RagService } = require('/app/apps/api/dist/rag/rag.service');
const { AuditService } = require('/app/apps/api/dist/audit-logs/audit.service');
const { RedisService } = require('/app/apps/api/dist/redis/redis.service');
const { NestToolLogger } = require('/app/apps/api/dist/common/tool-logger');

// Actual compiled providers/persistence; synthetic file source/policy, no external requests.
(async () => {
  assert.equal(process.env.REDIS_URL, 'redis://redis:6379');
  const db = new PrismaClient();
  const redis = new RedisService({ redisUrl: process.env.REDIS_URL });
  await redis.onModuleInit();
  try {
    const owner = await db.user.findUniqueOrThrow({ where: { email: 'owner-c1@example.invalid' }, select: { id: true } });
    const membership = await db.membership.findFirstOrThrow({ where: { userId: owner.id }, select: { organizationId: true } });
    const repository = await db.repository.upsert({
      where: { organizationId_githubId: { organizationId: membership.organizationId, githubId: 9901 } },
      create: { organizationId: membership.organizationId, githubId: 9901, name: 'c1-diagnostics', fullName: 'synthetic/c1-diagnostics', owner: 'synthetic' }, update: {},
    });
    const client = {
      getDefaultBranchSha: async () => 'c1-synthetic-sha',
      listTree: async () => ({ files: [{ path: 'docs/example.md', sizeBytes: 100 }], truncated: false }),
      getFileContent: async () => '# Synthetic C1\nDiagnostic safety evidence.\n',
    };
    const prisma = { unscoped: db };
    const rag = new RagService(prisma, redis, {
      redisUrl: process.env.REDIS_URL,
      rag: { embeddingProvider: 'openai', embeddingDimensions: 1536, maxIndexedFiles: 10 },
      ai: { apiKeys: { openai: 'C1_PROVIDER_KEY_MARKER' }, baseUrls: {} },
    }, { forRepository: async () => ({ client }) }, new AuditService(prisma), {
      getPolicy: async () => ({ excludePatterns: [] }),
      getAiSettings: async () => ({ embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-small' }),
    });
    const progress = await rag.indexRepository({ organizationId: membership.organizationId, repositoryId: repository.id, userId: owner.id, force: true });
    assert.equal(progress.status, 'FAILED'); assert.ok(progress.error.includes('HTTP 401'));
    // Let best-effort progress updates settle before inspecting final durable diagnostics.
    await new Promise(resolve => setTimeout(resolve, 100));
    const persisted = await db.repository.findUniqueOrThrow({ where: { id: repository.id }, select: { indexError: true } });
    const runs = await db.indexRun.findMany({ where: { repositoryId: repository.id }, select: { error: true } });
    const audit = await db.auditLog.findMany({ where: { resourceId: repository.id }, select: { description: true, metadata: true } });
    assert.ok(persisted.indexError); assert.ok(runs.length); assert.ok(audit.length);
    const errors = [];
    for (const Provider of [OpenAiProvider, AnthropicProvider]) {
      try { await new Provider({ apiKey: 'C1_PROVIDER_KEY_MARKER', model: 'synthetic' }).complete({ messages: [{ role: 'user', content: 'Synthetic evidence' }] }); assert.fail('Synthetic provider should reject'); }
      catch (error) { assert.equal(error.status, 401); errors.push({ message: error.message, detail: error.detail }); }
    }
    const logger = new NestToolLogger('C1DiagnosticProof');
    for (const error of errors) logger.error(error.message, { detail: error.detail });
    const evidence = JSON.stringify({ progress, persisted, runs, audit, errors });
    for (const marker of ['C1_PROVIDER_BODY_MARKER', 'C1_PROVIDER_CODE_MARKER', 'C1_PROVIDER_KEY_MARKER']) assert.ok(!evidence.includes(marker));
    console.log(JSON.stringify({ diagnosticRuntime: 'PASS', realIndexRunErrorPersistence: true, realRepositoryErrorPersistence: true, realAuditPersistence: true, llmAdaptersTested: 2, markerOccurrences: 0 }));
  } finally { await redis.onModuleDestroy(); await db.$disconnect(); }
})().catch(() => { console.error('C1 container diagnostic proof FAILED; sensitive details withheld'); process.exitCode = 1; });
