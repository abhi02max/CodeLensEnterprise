# Verification and Claim Audit

Evidence checkpoint: Phase 2F, 2026-09-30, based on HEAD
`c2546d3e24069b3f5e873a2ca97abbeafd3b2cb9` plus the uncommitted hardening diff.
No Phase 2F commit or hosted Actions run is claimed here.

Final deterministic result after adversarial corrections: 67 root tests (database 6, static analysis 11, RAG 9,
AI agent 18, API 23; shared/GitHub 0), plus 11 Python tests. Prisma validation,
generation, workspace typecheck and the full packages/API/web build passed.
Browser results are separate runtime evidence, not additional unit-test totals.
Prisma validation/generation, workspace typecheck and the full root build were
rerun during the adversarial review. API tests are included in root totals, while
Python/browser checks are separate. An intentional temporary failing API test
made root `pnpm test` exit 1; the temporary file was removed and root tests rerun.
Local tools were Node 26.5.0 and pnpm 11.25.0; Docker builds used the pinned
Node 22/pnpm 11.13.0 path. This was a clean-volume/container proof from the current
checkout, not a literal separate Git clone.

## Reproducible Commands

Use `pnpm install --frozen-lockfile`, `pnpm db:validate`, `pnpm db:generate`, `pnpm build:packages`,
`pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:browser`.
Browser commands require explicit URLs/password and installed Chrome; see the
[demo runbook](demo-runbook.md). Root tests include database lifecycle tests;
shared/GitHub legitimately have zero test files and only those packages use
`--passWithNoTests`. Real failures in other packages still fail the root command.

CI uses Node 22, pnpm 11.13.0, a disposable pgvector PostgreSQL service, baseline
migration deployment and RAG verification before deterministic tests/builds.
Python 3.12 runs the feature-contract suite. No paid credentials are required.
Hosted CI execution: **UNVERIFIED**. No remote Actions execution is claimed before pushing the changes.
Actions use major release tags, not immutable SHA pins. The small CI does not
run Redis/worker integration, browsers, Docker image builds, model training or
advisory dependency/security scans. Docker's ML image build retains its model
load/quality check; removing the old CI jobs does not prove those excluded checks.

There is no repository ESLint gate configured. Prettier's existing whole-tree
format check reports 119 files requiring formatting. Python Ruff reports nine
pre-existing violations. Neither is represented as passing CI. Static analysis
of PR content is a separate product capability, not repository lint coverage.

## Current Runtime Evidence

The fresh lifecycle used a new disposable project `codelens_phase2f_20260930`,
not the original project or the prior demo volume. New volumes:
`codelens_phase2f_20260930_postgres_data`,
`codelens_phase2f_20260930_redis_data`, and
`codelens_phase2f_20260930_ml_org_models`.
Ports: web 23000, API 24000, PostgreSQL 25433, Redis 26379, ML 28000.
The ignored override changes fixed container names and browser/CORS URLs;
ignored `.env.phase2.local` supplies generated local secrets. Neither is commit content.

- Frozen container installs and API/worker/web/ML builds completed.
- Fresh db-init reported `Database state: empty`, applied `0_baseline`, and
  finished `Database migrations and RAG infrastructure ready`.
- SQL confirmed one successful migration, vector/pg_trgm/pgcrypto, vector(1536),
  stored generated weighted English tsvector and all three RAG indexes.
- Before explicit seed: Organization, Repository, PullRequest, RagChunk and
  ReviewRun counts were all zero. No database schema was copied from another volume.
- Repeat db-init reported managed/no pending migrations. Down/up without `-v`
  retained the seeded rows. Seed produced one demo organization, one repository,
  two PRs, three chunks, zero embeddings and one fixture ReviewRun.
- PR #412 remained four changed files, +26/-5, 31 changed lines.
- A live queued analysis produced risk 91, four findings and AI SKIPPED without
  provider credentials. Seeded reviews are not counted as live pipeline proof.
- Critical browser path passed with 157 API requests, no JS/network errors and
  11 navigation cancellations. Walkthrough: 82 passed, zero failures, zero layout
  issues; two expected unauthenticated/sign-in 401 console resource errors.
- Worker stopped: forced analysis remained QUEUED (maxAttempts=2). Restart:
  the same job completed in one attempt, run `cmuo2c1yo0001qj014tvkmtrc`.
- Real indexing request failed once, retained FAILED state (maxAttempts=3), with
  an explicit missing-embedding-provider validation reason. No retry was wasted
  on that deterministic failure. Transient retry execution: **UNVERIFIED**.
- Python cross-language feature contracts: 11 passed. The initial disposable
  runner needed module invocation/cache relocation; that was runner setup, not
  a product failure. No source mount was writable.

Final adversarial runtime checks: six concurrent readiness calls during an isolated
Redis outage returned HTTP 503/down in 5.1-5.2 seconds. Liveness remained 200 and
Redis was restored. Final images were rebuilt after removing the intentional
negative-test file; an in-container check confirmed the file is absent. db-init
still reported managed/no pending migrations. Browser diagnostic redaction was
also exercised directly with non-secret sentinel token/password strings.
Final browser rerun after diagnostic corrections: critical path passed with 157
API requests, no JS/network errors and nine navigation cancellations. Walkthrough
passed 81 checks with zero failures/layout issues and two expected auth 401 resource
errors. The finding-anchor creation check was skipped because earlier runs already
created threads for every finding; this is not silently counted as another pass.

## Operations and Limits

Liveness checks only process responsiveness. Aggregate readiness requires
Postgres and Redis; ML, configured AI and queue backlog are optional checks.
AI configuration is not provider reachability. Tenant-specific GitHub accounts
are not checked by global readiness. A Redis outage exposed an unbounded health
request; the correction bounds dependency probes and the independent cache
client, leaving BullMQ blocking workers reconnectable.
The final review additionally coalesces dependency probes: a timed-out probe's
bounded result is reused until the underlying Prisma/BullMQ command settles.
Timeout does not cancel such commands; this caps outstanding probes per dependency
instead of accumulating new work on every readiness request. Late rejection and
settlement are handled; tests verify timers and recovery. A permanently stuck
command continues to report down until it settles or the process restarts.
After rebuilding the isolated API/worker, the same outage returned HTTP 503 in
5.7 seconds, with Redis required/down and queue timeout optional/down; liveness
remained HTTP 200. Redis was restored in a finally block. A concurrent ML probe
also timed out in that sample; it was reported rather than assumed healthy.

Logs use Nest messages with key/value context, not universal JSON structured
logging. HTTP errors now include trace IDs; worker active/completed/failed events
include the enqueue trace. ReviewRun/ToolRun persistence provides run correlation.
Inbound request IDs are restricted to word/dot/hyphen characters and 64 characters;
otherwise a UUID is generated. Caller-provided IDs need not be globally unique
and are correlation only, never tenant authorization. Job payloads preserve the
trace through worker/tool execution rather than generating a new one per stage.
Share-token paths are redacted. Current-tree secret inspection found intentionally
fake scanner fixtures, not a real provider credential. This is not a complete
historical secret scan or certification.

API and worker enable Nest shutdown hooks; Prisma disconnects, Redis quits with
disconnect fallback, and Nest BullMQ closes workers/queues. An idle SIGTERM stop
and restart succeeded. Active-job graceful shutdown/draining: **UNVERIFIED**.
Active-job draining under deployment timeout and crash/
lock-expiry recovery are not fully runtime-proven. Compose's default stop timeout
can interrupt a long job; do not claim zero-loss graceful redeploy for all workloads.
The restart proof stopped an idle worker before enqueueing: it proves queued-work
survival and subsequent consumption, not interrupted active-job recovery.
Analysis retries are capped at two attempts with 30s exponential backoff; indexing
uses configured attempts and 60s backoff; PR sync uses configured attempts and
15s backoff. Locks are 300s for analysis/sync and 600s for indexing. Installed
BullMQ defaults are 30s stalled checks and one allowed stall. Completed jobs are
retained for up to one day/1000 entries and failed jobs seven days/1000 entries;
these are bounded diagnostics, not an indefinite archive.

### Phase 2G-A Runtime Reliability Update (2026-09-30)

The shutdown statements above describe the Phase 2F checkpoint. Phase 2G-A
replaced Nest signal-hook ordering with an explicit sequence: mark draining,
pause BullMQ workers, wait for active work, close workers and queues, then close
Nest application dependencies (including Prisma and Redis). The default active
drain budget is 180 seconds, followed by up to 10 seconds for cleanup; Compose
grants 200 seconds. Operators changing the drain budget must also increase the
Compose grace period so it remains greater than drain plus cleanup.
The remaining 10 seconds allow for signal delivery and process scheduling.

In isolated project `codelens_phase2f_20260930`, a real review-run job failed
transiently before analysis, became delayed for the configured 30-second backoff,
and completed on its second attempt with the same BullMQ job ID. The API returned
the single completed authoritative run, with no active orphan. A separate
two-job SIGTERM test showed job A retaining working PostgreSQL and Redis
connections after drain began and completing within the budget; job B stayed
waiting until a replacement worker consumed it. The final image also passed an
idle SIGTERM smoke test after explicit queue closure was added. Focused tests
cover timeout, failed cleanup, repeated shutdown, and terminal-run handling.
BullMQ pause is local to the draining worker, not queue-global. It sets the
worker's paused flag asynchronously; a job acquired in the tiny interval from
signal delivery to that flag may still start and become part of the active drain.
The observed B-waiting result is evidence for that run, not a mathematical
guarantee that no job can be acquired in this interval.

If an active job exceeds the budget, the worker attempts a bounded forced close
and exits nonzero without first disconnecting Prisma or Redis from an active
processor. BullMQ's stalled-job recovery remains available, but deadline-overrun
runtime recovery, host-level SIGKILL behavior, immediate stalled recovery, and
external side-effect exactly-once behavior were not proven. A prior
run's ID is carried across retries so an abandoned RUNNING row can be marked
FAILED before a new attempt; Redis lock expiry can still delay reprocessing.
Analysis locks now use per-acquisition tokens and atomic compare-and-delete so
an expired owner's cleanup cannot remove a replacement owner's lock.

The isolated image recreation initially omitted `--env-file .env.phase2.local`
and therefore received Compose's default database password. No data was changed;
recreation with the isolated env file recovered the stack. Every isolated
Compose invocation must supply both its project name and env file; the project
name alone does not select its credentials.

Images install from the frozen lockfile, but base tags are not digest-pinned.
API/web retain development dependencies and run as root; ML runs non-root.
Root `.dockerignore` excludes secret env files. This is local/portfolio deployment,
not hardened Internet-facing production. Compose initially waits for healthy ML,
although an ML outage after startup is an optional degradation.

## External Smoke Tests

**GitHub: EXTERNAL-CREDENTIAL BLOCKED.** No usable GitHub Account was configured
in the isolated database. Configure the OAuth application client ID/secret and
callback URL from `.env.example`; connect a controlled account through the
implemented GitHub OAuth flow. Required scopes are read:user, user:email and repo
for private repositories. Tokens are encrypted in Account using ENCRYPTION_KEY;
setting an arbitrary PAT environment variable is not this application's auth path.
The entry point is `GET /api/v1/auth/github`; linking an existing account uses
`mode=link` and a bearer header. The callback is `/api/v1/auth/github/callback`.

With an authenticated access token held privately in `$headers` and base API in
`$api`, use the implemented routes (substitute controlled IDs, not demo IDs):

```powershell
# Browse available repositories and choose one with non-sensitive test content.
Invoke-RestMethod "$api/repositories/available" -Headers $headers
# Connect as ADMIN/OWNER; body: githubId, fullName, autoIndex=false.
Invoke-RestMethod "$api/repositories" -Method Post -Headers $headers -ContentType application/json -Body $connectBody
Invoke-RestMethod "$api/repositories/$repositoryId/index" -Method Post -Headers $headers -ContentType application/json -Body '{"force":true}'
Invoke-RestMethod "$api/repositories/$repositoryId/sync" -Method Post -Headers $headers -ContentType application/json -Body '{"state":"open","limit":10}'
Invoke-RestMethod "$api/pull-requests/$pullRequestId/analyze" -Method Post -Headers $headers -ContentType application/json -Body '{"force":true,"postToGithub":false}'
# Poll each queued operation via its returned pollUrl/job handle.
Invoke-RestMethod "$api/review-sessions/$pullRequestId" -Headers $headers
```

Configure a legitimate embedding provider as well before indexing. Record file/
chunk counts, non-null vector dimensions, run ID and retrieved evidence. Do not
post to GitHub or report success unless those operations actually complete.

**Real AI: EXTERNAL-CREDENTIAL BLOCKED.** The local provider value used in earlier
Phase 2C was a wire-format test double, not a paid-provider credential. OpenAI,
Anthropic and OpenRouter adapters are implemented. Configure one legitimate key,
model and provider in an ignored env file; recreate only the isolated API/worker.
Run one controlled `postToGithub:false` analysis and inspect the session's AI
status, persisted AiReview and provider/model metadata. Do not print keys or
tokens. Deterministic response validation/repair evidence is not real inference
quality, provider compatibility at deployment time or semantic embedding quality.

## Claim Audit

Optional browser follow-ups: provider-absent rendering and sign-in keyboard focus
(email to password to Sign in) passed. A dedicated ML-unavailable browser run,
clipboard action and full keyboard-only walkthrough were not performed; do not
infer them from ordinary mouse-driven flows.

## Proposed Commit Groups

Inventory review: the original 19 files matched exactly. The adversarial review
adds `base.processor.test.ts` and a narrow walkthrough diagnostic-URL correction,
bringing the final inventory to 21:

| Category | Files |
| --- | --- |
| CI | `.github/workflows/ci.yml` |
| Test infrastructure | Root `package.json`; API, database, GitHub and shared `package.json` |
| Readiness/reliability | `health.service.ts`, `health.service.test.ts`, `redis.service.ts`, `queues.module.ts` |
| Observability | `all-exceptions.filter.ts`, `base.processor.ts`, `base.processor.test.ts` |
| Browser reproducibility | `critical-path.mjs`, `browser-walkthrough.mjs` |
| Repository hygiene | `.gitignore` |
| Documentation | README, architecture, portfolio, demo-runbook and verification |

No migrations, product features, generated output or isolation configurations
are part of this inventory. No unexplained formatting-only change was retained.

## Final Adversarial Findings

- Readiness timeout returned promptly but left uncancellable BullMQ/Prisma probes
  running; repeated requests could accumulate commands. Corrected with bounded
  per-dependency coalescing and tests for repeated calls, late success/rejection
  and timer cleanup. No new Redis connections are created by health requests.
- CI checked workspace consumers before producing dependency declarations.
  `tsconfig.base.json` intentionally resolves workspace packages through their
  `dist` entry points. Added `build:packages` before typecheck/tests and documented
  that prerequisite; frozen Docker builds establish the clean package build path.
- Worker failure logs incorrectly promised retries for UnrecoverableError.
  Corrected to report unrecoverable/exhausted failures as giving up and remaining
  transient attempts as retry eligible, not guaranteed retry execution.
- The configured-provider test exercised the unconfigured branch. Corrected to
  assert the configured branch explicitly denies reachability verification.
- README overstated walkthrough console-error enforcement. Corrected: the
  walkthrough records those errors; the critical path enforces JS/network checks.
- Failure-only browser diagnostics could print share capability tokens in URLs.
  Redacted both share/shared paths; walkthrough diagnostic URLs also omit query
  strings and fragments, including the credential-in-URL regression diagnostic.
- Hybrid/MMR classification downgraded to PARTIAL because MMR-specific runtime
  evidence was not separately recorded. Completion remains approximately 90%,
  with external verification and reliability boundaries unchanged.

## Proposed Changesets

Changed files:

- `.github/workflows/ci.yml`
- `.gitignore`
- `package.json`
- `apps/api/package.json`
- `packages/database/package.json`
- `packages/github/package.json`
- `packages/shared/package.json`
- `apps/api/src/common/all-exceptions.filter.ts`
- `apps/api/src/health/health.service.ts`
- `apps/api/src/health/health.service.test.ts` (new)
- `apps/api/src/queues/processors/base.processor.ts`
- `apps/api/src/queues/processors/base.processor.test.ts` (new)
- `apps/api/src/queues/queues.module.ts`
- `apps/api/src/redis/redis.service.ts`
- `apps/web/test/critical-path.mjs`
- `apps/web/test/browser-walkthrough.mjs`
- `README.md`
- `docs/architecture.md`
- `docs/portfolio.md`
- `docs/demo-runbook.md` (new)
- `docs/verification.md` (new)

No commits have been created. Review these groups before committing:

1. Repository checks/CI: root and package scripts, GitHub Actions, browser test
   reproducibility (authoritative score readback and normal outsider signup).
2. Runtime correctness: bounded/coalesced readiness, cache connection options,
   focused tests, explicit AI configuration wording and BullMQ reconnect comment.
3. Observability: error/worker trace correlation, unrecoverable failure retry
   diagnostics and processor tests.
4. Documentation/hygiene: README, architecture/portfolio corrections, demo runbook,
   this evidence document and ignore rules for local secret/Compose files.

Keep both local Compose overrides, secret env files and browser screenshots out
of all commits. No migration, seed fixture, auth, tenant policy or product feature
was intentionally changed. Applied `0_baseline` remains untouched.

Runtime classifications include previously completed Phases 2A-E. They do not
claim paid integrations, exhaustive security coverage or production scale.

## Capability Classifications

| Capability | Classification | Evidence / boundary |
| --- | --- | --- |
| Docker deployment | RUNTIME PROVEN | Isolated fresh stack and repeat startup |
| Clean database migration | RUNTIME PROVEN | Empty SQL counts, baseline and managed restart |
| BullMQ analysis pipeline | RUNTIME PROVEN | New queued run and persisted result |
| Static analysis | RUNTIME PROVEN | Four live demo findings; external binaries optional |
| Deterministic line anchors | AUTOMATED-TEST PROVEN | 11 analyzer tests plus browser readback |
| ML risk service | RUNTIME PROVEN | Python bootstrap prediction consumed by worker |
| Repository indexing | RUNTIME PROVEN | Phase 2C real package path with deterministic embeddings; not live GitHub |
| pgvector retrieval | RUNTIME PROVEN | Phase 2C vector queries; synthetic embedding boundary |
| Lexical retrieval | RUNTIME PROVEN | Database FTS retrieval and demo context |
| Hybrid retrieval/MMR | PARTIAL | Hybrid queries runtime-proven; MMR has no separately recorded runtime proof |
| RAG provenance | RUNTIME PROVEN | Phase 2C truthful source/score evidence |
| AI orchestration | RUNTIME PROVEN | Provider double and no-provider pipeline |
| Structured validation/repair | RUNTIME PROVEN | Phase 2C controlled provider errors/repair |
| Real AI provider | IMPLEMENTED / NOT EXTERNALLY VERIFIED | Credential blocked |
| GitHub repository integration | IMPLEMENTED / NOT EXTERNALLY VERIFIED | OAuth/client implemented; credential blocked |
| Authoritative ReviewRun semantics | RUNTIME PROVEN | Phase 2D-E plus run-selection tests |
| Comments/replies | RUNTIME PROVEN | API and browser collaboration flow |
| Verdicts | RUNTIME PROVEN | Approval/request changes and author guard |
| Review gates | RUNTIME PROVEN | Policy reasons and verdict readback |
| Share links/revocation | RUNTIME PROVEN | Protected and anonymous readback/revocation |
| Multi-tenant isolation | RUNTIME PROVEN | Outsider gets 404; not a penetration test |
| Audit logs | RUNTIME PROVEN | Persisted activity and browser human descriptions |
| Graceful degradation | RUNTIME PROVEN | No-provider state; outage readiness check |
| Responsive browser workflow | RUNTIME PROVEN | Critical path and walkthrough; not full WCAG |
| CI | IMPLEMENTED / NOT EXTERNALLY VERIFIED | Local checks pass; hosted run pending |
| Worker recovery | PARTIAL | Same-job transient retry and queued restart runtime-proven; forced-stop/lock-expiry recovery unverified |
| Observability | PARTIAL | IDs correlate logs and persistence; no platform/metrics tracing |
| Graceful active-job shutdown | PARTIAL | Active SIGTERM drain and waiting-job isolation runtime-proven; deadline overrun not runtime-proven |

## Completion Estimate

Approximately 90% portfolio complete is a judgement, not a coverage calculation.
Core product: roughly 95%; engineering/reliability: roughly 85%; external
verification: blocked, not complete. Optional commercial features (SSO, IDE,
additional hosts/integrations) are outside this portfolio definition.

100% means a stranger can follow documented setup/demo, pass canonical checks and
hosted CI, reproduce recovery/readiness, and inspect one controlled real GitHub
and provider run, with limitations stated honestly. It does not mean commercial
scale, certifications or feature parity with established review vendors.
