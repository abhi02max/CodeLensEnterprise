// Explicit test-only entrypoint; never loaded by the API or normal worker.
require('reflect-metadata');
const assert = require('node:assert/strict');
if (process.env.NODE_ENV !== 'test' || process.env.RELIABILITY_PROJECT !== 'codelens_phase2f_20260930') {
  throw new Error('Requires explicitly verified isolated Phase 2F project and NODE_ENV=test');
}
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { AnalysisService } = require('../dist/analysis/analysis.service');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { RedisService } = require('../dist/redis/redis.service');
const { QueueService } = require('../dist/queues/queue.service');
const { ReviewRunProcessor } = require('../dist/queues/processors/review-run.processor');
const { installShutdown } = require('../dist/queues/application-shutdown');
const { Role } = require('@codelens/shared');
const { decodeJobHandle } = require('../dist/queues/queue.types');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let proofStage = 'bootstrap';
function evidence(event, data = {}) {
  console.log(JSON.stringify({ proof: event, at: new Date().toISOString(), ...data }));
}
async function main() {
  const mode = process.argv[2];
  assert.ok(['retry', 'drain', 'enqueue', 'enqueue-pair', 'readback'].includes(mode));
  const app = await NestFactory.createApplicationContext(AppModule);
  installShutdown(app);
  const prisma = app.get(PrismaService).unscoped;
  const redis = app.get(RedisService);
  const queues = app.get(QueueService);
  const processor = app.get(ReviewRunProcessor);
  const analysis = app.get(AnalysisService);
  const pr = await prisma.pullRequest.findFirstOrThrow({ where: { number: 412,
    repository: { fullName: 'acme-engineering/payments-api' } } });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'owner@acme.dev' } });
  const trace = process.env.RELIABILITY_TRACE;
  assert.match(trace || '', /^reliability-[a-z0-9-]+$/);
  const data = { organizationId: pr.organizationId, pullRequestId: pr.id,
    repositoryId: pr.repositoryId, headSha: pr.headSha, userId: owner.id,
    userRole: Role.OWNER, traceId: trace, trigger: 'USER',
    force: true, postToGithub: false };
  const original = analysis.run.bind(analysis);
  let calls = 0;
  analysis.run = async (params) => {
    calls += 1;
    if (mode === 'retry' && calls === 1) {
      evidence('injected-transient-before-analysis', { trace });
      throw new Error('Controlled test-only transient failure before analysis');
    }
    if (mode === 'drain') {
      evidence('long-job-entered', { trace: params.traceId });
      await sleep(Number(process.env.RELIABILITY_DELAY_MS || '25000'));
      const rows = await prisma.$queryRawUnsafe('SELECT 1 AS alive');
      const ping = await redis.client.ping();
      assert.equal(rows[0].alive, 1);
      assert.equal(ping, 'PONG');
      evidence('dependencies-usable-after-delay', { trace: params.traceId, database: true, redis: true });
    }
    return original(params);
  };
  if (mode === 'enqueue' || mode === 'enqueue-pair') {
    const handle = await queues.enqueueAnalysis(data);
    evidence('enqueued', { jobId: decodeJobHandle(handle.id).jobId, trace });
    if (mode === 'enqueue-pair') {
      const next = await queues.enqueueAnalysis({ ...data, traceId: `${trace}-b` });
      evidence('enqueued', { jobId: decodeJobHandle(next.id).jobId, trace: `${trace}-b` });
    }
    // This short-lived producer owns no active worker. Queue.add has completed its
    // Redis write; process exit avoids unrelated Nest producer-connection shutdown.
    return;
  }
  if (mode === 'readback') {
    const { Queue } = require('bullmq');
    const job = new Queue('review-run', { connection: { url: process.env.REDIS_URL },
      prefix: process.env.QUEUE_PREFIX || 'codelens' });
    try {
      const selected = await job.getJob(process.env.RELIABILITY_JOB_ID);
      assert.ok(selected);
      const state = await selected.getState();
      evidence('job-readback', { jobId: selected.id, trace: selected.data.traceId,
        state, attemptsMade: selected.attemptsMade,
        result: selected.returnvalue && { reviewRunId: selected.returnvalue.reviewRunId,
          status: selected.returnvalue.status, reused: selected.returnvalue.reused } });
      if (process.env.RELIABILITY_EXPECT_WAITING === 'true') assert.equal(state, 'waiting');
      else {
        assert.equal(state, 'completed');
        const run = await prisma.reviewRun.findUniqueOrThrow({ where: { id: selected.returnvalue.reviewRunId } });
        assert.ok(['COMPLETED', 'PARTIAL'].includes(run.status));
        const running = await prisma.reviewRun.count({ where: { pullRequestId: pr.id, status: 'RUNNING' } });
        assert.equal(running, 0);
        proofStage = 'api-signin';
        const authResponse = await fetch('http://api:4000/api/v1/auth/signin', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'owner@acme.dev', password: process.env.DEMO_PASSWORD }) });
        evidence('api-signin-status', { status: authResponse.status });
        assert.ok(authResponse.ok);
        const auth = await authResponse.json();
        const token = auth.tokens?.accessToken;
        assert.ok(token);
        proofStage = 'api-session';
        const response = await fetch(`http://api:4000/api/v1/review-sessions/${pr.id}`, {
          headers: { Authorization: `Bearer ${token}` } });
        evidence('api-session-status', { status: response.status });
        assert.ok(response.ok);
        const session = await response.json();
        const current = session.data || session;
        proofStage = 'api-authoritative-run';
        assert.equal(current.run.id, run.id);
        evidence('authoritative-readback', { jobId: selected.id, reviewRunId: run.id,
          status: run.status, running, apiMatches: true });
      }
    } finally { await job.close(); await app.close(); }
    return;
  }
  processor.worker.concurrency = 1;
  const events = [];
  processor.worker.on('active', (job) => {
    events.push({ event: 'active', jobId: job.id, attemptsMade: job.attemptsMade, time: Date.now() });
    evidence('active', { jobId: job.id, trace: job.data.traceId, attemptsMade: job.attemptsMade });
  });
  processor.worker.on('failed', (job) => evidence('failed', {
    jobId: job.id, trace: job.data.traceId, attemptsMade: job.attemptsMade }));
  processor.worker.on('completed', (job) => evidence('completed', {
    jobId: job.id, trace: job.data.traceId, attemptsMade: job.attemptsMade,
    reviewRunId: job.returnvalue?.reviewRunId, status: job.returnvalue?.status }));
  void processor.worker.run().catch(() => {});
  evidence('worker-ready', { mode });
  if (mode === 'drain') return;
  const before = await prisma.reviewRun.count({ where: { pullRequestId: pr.id } });
  const handle = await queues.enqueueAnalysis(data);
  const jobId = decodeJobHandle(handle.id).jobId;
  const { Queue } = require('bullmq');
  const queue = new Queue('review-run', { connection: { url: process.env.REDIS_URL },
    prefix: process.env.QUEUE_PREFIX || 'codelens' });
  try {
    let delayed = false;
    let completed;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const job = await queue.getJob(jobId);
      const state = await job.getState();
      if (state === 'delayed' && !delayed) {
        delayed = true;
        assert.equal(job.attemptsMade, 1);
        assert.equal(job.opts.backoff.delay, 30_000);
        evidence('delayed-retry', { jobId: job.id, attemptsMade: job.attemptsMade, backoffMs: job.opts.backoff.delay });
      }
      if (state === 'completed') { completed = job; break; }
      assert.notEqual(state, 'failed');
      await sleep(200);
    }
    assert.ok(completed);
    assert.ok(delayed);
    assert.equal(completed.attemptsMade, 2);
    assert.equal(events.length, 2);
    assert.equal(events[0].jobId, events[1].jobId);
    assert.ok(events[1].time - events[0].time >= 29_500);
    assert.equal(await prisma.reviewRun.count({ where: { pullRequestId: pr.id } }), before + 1);
    assert.equal(await prisma.reviewRun.count({ where: { pullRequestId: pr.id, status: 'RUNNING' } }), 0);
    evidence('retry-passed', { jobId: completed.id, attemptsMade: completed.attemptsMade,
      backoffElapsedMs: events[1].time - events[0].time, newRuns: 1,
      reviewRunId: completed.returnvalue.reviewRunId, status: completed.returnvalue.status });
  } finally { await queue.close(); await app.close(); }
}
main().then(() => { if (process.argv[2] !== 'drain') process.exit(0); }).catch((error) => {
  // Avoid dumping response bodies/configuration from a diagnostic test process.
  evidence('proof-failed', { stage: proofStage, errorType: error?.name || 'Error' }); process.exit(1);
});
