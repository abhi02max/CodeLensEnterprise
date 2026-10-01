require('reflect-metadata');
const assert = require('node:assert/strict');
if (process.env.NODE_ENV !== 'test' || process.env.RETRIEVAL_PROJECT !== 'codelens_phase2f_20260930') {
  throw new Error('Requires explicitly verified isolated project and NODE_ENV=test');
}
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { RagService } = require('../dist/rag/rag.service');
const { QueueService } = require('../dist/queues/queue.service');
const { ReviewRunProcessor } = require('../dist/queues/processors/review-run.processor');
const { PgVectorStore, HybridRetriever, fuseCandidates } = require('@codelens/rag-engine');
const { RetrieveContextSchema, Role } = require('@codelens/shared');
const { decodeJobHandle } = require('../dist/queues/queue.types');
const { Queue } = require('bullmq');
const vector = (x, y) => [x, y, ...Array(1534).fill(0)];
const provider = { model: 'synthetic-mechanics-only', dimensions: 1536,
  embedOne: async () => vector(1, 0), embed: async (texts) => texts.map(() => vector(1, 0)) };
let stage = 'bootstrap';
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService).unscoped;
  const rag = app.get(RagService);
  const processor = app.get(ReviewRunProcessor);
  const pr = await prisma.pullRequest.findFirstOrThrow({ where: { number: 412,
    repository: { fullName: 'acme-engineering/payments-api' } } });
  const stamp = Date.now().toString(36);
  const ids = ['A', 'B', 'C', 'N'].map((id) => `mechanics-${stamp}-${id}`);
  let repository;
  let queue;
  try {
    stage = 'fixture';
    repository = await prisma.repository.create({ data: { organizationId: pr.organizationId,
      githubId: -Math.floor(Date.now() / 1000), fullName: `mechanics/${stamp}`, name: stamp,
      owner: 'mechanics', indexStatus: 'INDEXED' } });
    const chunks = [
      { path: 'README.md', symbol: 'mechanicskeyword', content: 'mechanicskeyword refund error conventions', embedding: vector(1, 0) },
      { path: 'b.ts', symbol: 'nearDuplicate', content: 'refund errors', embedding: vector(0.999, 0.04) },
      { path: 'c.ts', symbol: 'different', content: 'database schema migrations', embedding: vector(0.5, 0.8660254) },
      { path: 'n.ts', symbol: 'negative', content: 'opposite vector', embedding: vector(-1, 0) },
    ].map((row, i) => ({ ...row, id: ids[i], repositoryId: repository.id, kind: 'FUNCTION', language: 'typescript',
      startLine: 1, endLine: 1, tokenCount: 10, contentHash: `mechanics-${stamp}-${i}`,
      metadata: { imports: i === 3 ? [] : ['./target'], exports: [], route: null, linkedTestPath: null, parentSymbol: null,
        docComment: null, isPartial: false, partIndex: null }, embeddingModel: provider.model }));
    const store = new PgVectorStore(prisma, pr.organizationId);
    await store.upsert(chunks);
    const params = RetrieveContextSchema.parse({ repositoryId: repository.id, query: 'mechanicskeyword',
      symbols: ['mechanicskeyword'], graphSeedPaths: ['target.ts'], topK: 2, mmrLambda: 0.5 });
    stage = 'retrieval';
    const subject = new HybridRetriever({ store, embeddings: provider });
    const pure = await subject.retrieve({ ...params, mmrLambda: 1 });
    const diverse = await subject.retrieve(params);
    const groups = [
      { source: 'VECTOR', hits: await store.search({ repositoryId: repository.id, embedding: vector(1, 0), topK: 24 }) },
      { source: 'LEXICAL', hits: await store.searchLexical({ repositoryId: repository.id, terms: params.symbols, topK: 24 }) },
      { source: 'IMPORT_GRAPH', hits: await store.searchImportGraph({ repositoryId: repository.id, seedPaths: ['target.ts'], topK: 12 }) },
      { source: 'CONVENTION', hits: await store.findByPaths({ repositoryId: repository.id, paths: ['README.md'], limit: 8 }) },
    ];
    const fused = fuseCandidates(groups);
    assert.equal(fused.size, 4);
    assert.deepEqual(pure.chunks.map((c) => c.chunkId), [ids[0], ids[1]]);
    assert.deepEqual(diverse.chunks.map((c) => c.chunkId), [ids[0], ids[2]]);
    assert.deepEqual(diverse.chunks[0].sources, ['VECTOR', 'LEXICAL', 'IMPORT_GRAPH', 'CONVENTION']);
    assert.equal(fused.get(ids[3]).vectorScore, -1);
    assert.ok(fused.get(ids[3]).score >= 0);
    console.log(JSON.stringify({ proof: 'hybrid-mmr', dimensions: 1536, candidateCounts: diverse.candidateCounts,
      fusedCount: fused.size, pure: pure.chunks, diverse: diverse.chunks, negative: fused.get(ids[3]),
      mmrAfterA: { B: 0.5 * fused.get(ids[1]).score - 0.5 * fused.get(ids[1]).vectorScore,
        C: 0.5 * fused.get(ids[2]).score - 0.5 * fused.get(ids[2]).vectorScore } }));
    const fallback = await new HybridRetriever({ store, embeddings: { ...provider,
      embedOne: async () => { throw new Error('controlled unavailable'); } } }).retrieve(params);
    assert.equal(fallback.candidateCounts.VECTOR, 0);
    assert.ok(fallback.chunks.every((c) => c.vectorScore === null && !c.sources.includes('VECTOR')));
    stage = 'queued-analysis';
    // Only this mounted test process substitutes the embedding provider. Queries, queue,
    // pipeline, persistence and API readback remain real; production has no hook.
    rag.embeddingProvider = async () => provider;
    await store.upsert(chunks.map((c) => ({ ...c, id: `${c.id}-demo`, repositoryId: pr.repositoryId })));
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'owner@acme.dev' } });
    const handle = await app.get(QueueService).enqueueAnalysis({ organizationId: pr.organizationId,
      pullRequestId: pr.id, repositoryId: pr.repositoryId, headSha: pr.headSha, userId: owner.id,
      userRole: Role.OWNER, traceId: `retrieval-${stamp}`, trigger: 'USER', force: true, postToGithub: false });
    queue = new Queue('review-run', { connection: { url: process.env.REDIS_URL }, prefix: process.env.QUEUE_PREFIX || 'codelens' });
    void processor.worker.run();
    const deadline = Date.now() + 120000;
    let job;
    while (Date.now() < deadline) {
      job = await queue.getJob(decodeJobHandle(handle.id).jobId);
      const state = await job.getState();
      assert.notEqual(state, 'failed');
      if (state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(await job.getState(), 'completed');
    const runId = job.returnvalue.reviewRunId;
    const rows = await prisma.retrievedContext.findMany({ where: { reviewRunId: runId } });
    assert.ok(rows.some((c) => c.sources.includes('VECTOR') && c.sources.length > 1));
    assert.ok(rows.some((c) => c.vectorScore < 0 && c.score >= 0), 'Negative raw similarity survives persistence without negative relevance');
    stage = 'api-readback';
    const authHttp = await fetch('http://api:4000/api/v1/auth/signin', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email, password: process.env.DEMO_PASSWORD }) });
    assert.ok(authHttp.ok);
    const auth = await authHttp.json();
    const headers = { Authorization: `Bearer ${auth.tokens.accessToken}` };
    const response = await fetch(`http://api:4000/api/v1/pull-requests/${pr.id}/rag-context`, { headers });
    assert.ok(response.ok);
    const readback = await response.json();
    assert.equal(readback.reviewRunId, runId);
    assert.equal(readback.chunks.length, rows.length);
    for (const row of rows) {
      const read = readback.chunks.find((c) => c.id === row.id);
      assert.deepEqual(read.sources, row.sources);
      assert.equal(read.vectorScore, row.vectorScore);
      assert.equal(read.lexicalScore, row.lexicalScore);
      assert.equal(read.score, row.score);
      assert.equal(read.rank, row.rank);
      assert.equal(read.chunkId, row.chunkId);
    }
    const sessionHttp = await fetch(`http://api:4000/api/v1/review-sessions/${pr.id}`, { headers });
    assert.ok(sessionHttp.ok);
    assert.equal((await sessionHttp.json()).run.id, runId);
    console.log(JSON.stringify({ proof: 'queued-persistence-readback', jobId: job.id, runId, count: rows.length,
      sources: [...new Set(rows.flatMap((c) => c.sources))], exactScoresAndSources: true,
      negativeAuditPreserved: true, rankAndIdsMatch: true }));
  } finally {
    if (processor.worker.isRunning()) await processor.worker.close();
    if (queue) await queue.close();
    await prisma.ragChunk.deleteMany({ where: { id: { in: ids.map((id) => `${id}-demo`) }, organizationId: pr.organizationId } });
    if (repository) await prisma.repository.delete({ where: { id: repository.id } });
    await app.close();
  }
}
main().then(() => process.exit(0)).catch((error) => {
  console.error(JSON.stringify({ proof: 'failed', stage, errorType: error.name })); process.exit(1);
});
