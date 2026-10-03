# Verification and Claim Audit

Latest checkpoint: Phase 2G certification-fix verification, 2026-10-02, based on
`5814bd8c51159c6d2ea88f20ed4d22a943ed1571` plus the uncommitted scoped fixes.
See the certification section below. No new commit or release certification is
claimed. Phase 2G-C2 evidence was committed in 5814bd8. Earlier checkpoint
statements are historical; their external-credential/hosted-CI boundaries are
superseded only by the specifically scoped evidence below.

Historical evidence checkpoint: Phase 2F, 2026-09-30, based on HEAD
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
shared/GitHub retain `--passWithNoTests` for legitimate empty-test handling;
both now have tests. Real test failures still fail the root command.

CI uses Node 22, pnpm 11.13.0, a disposable pgvector PostgreSQL service, baseline
migration deployment and RAG verification before deterministic tests/builds.
Python 3.12 runs the feature-contract suite. No paid credentials are required.
Hosted CI execution: **VERIFIED for SHA 5814bd8c51159c6d2ea88f20ed4d22a943ed1571**.
[Actions run 36969607790](https://github.com/abhi02max/CodeLensEnterprise/actions/runs/36969607790)
completed successfully; both Node and migration and ML contracts passed.
The earlier 368819a proof remains historical. Hosted execution of the current
uncommitted certification-fix diff remains **UNVERIFIED**.
Actions use major release tags, not immutable SHA pins. The small CI does not
run Redis/worker integration, browsers, Docker image builds, model training or
advisory dependency/security scans. Docker's ML image build retains its model
load/quality check; removing the old CI jobs does not prove those excluded checks.

There is no repository ESLint gate configured. The historical Phase 2F Prettier
count was 119. Exact tracked Git-content measurement at 5814bd8 found 146 failing
files versus 142 in its parent; four newly added files introduced the increase.
Windows checkout line endings inflate the raw whole-tree command's count, so
canonical comparisons use LF Git content and the pinned formatter/configuration.
Python Ruff reports nine
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
| Repository indexing | RUNTIME PROVEN | C2 real GitHub main tree and three real Gemini embeddings; earlier deterministic proof retained |
| pgvector retrieval | RUNTIME PROVEN | C2 real query embedding and persisted retrieval; semantic quality unvalidated |
| Lexical retrieval | RUNTIME PROVEN | Database FTS retrieval and demo context |
| Hybrid retrieval | REAL / PROVEN MECHANICS | Implemented, deterministic-test and database/runtime proven; semantic quality UNVALIDATED |
| MMR selection | REAL / PROVEN MECHANICS | Implemented, deterministic-test and runtime selection proven; semantic quality UNVALIDATED |
| RAG provenance | RUNTIME PROVEN | Phase 2C truthful source/score evidence |
| AI orchestration | RUNTIME PROVEN | Provider double and no-provider pipeline |
| Structured validation/repair | RUNTIME PROVEN | Phase 2C controlled provider errors/repair |
| Real AI provider | VERIFIED (GEMINI) | C2 completed structured review/test suggestions; OpenAI credit-blocked; other providers not externally verified |
| GitHub repository integration | VERIFIED (READ PATH) | C2 real OAuth, repository connection/indexing, PR import/diff; writes/webhooks not proven |
| Authoritative ReviewRun semantics | RUNTIME PROVEN | Phase 2D-E plus run-selection tests |
| Comments/replies | RUNTIME PROVEN | API and browser collaboration flow |
| Verdicts | RUNTIME PROVEN | Approval/request changes and author guard |
| Review gates | RUNTIME PROVEN | Policy reasons and verdict readback |
| Share links/revocation | RUNTIME PROVEN | Protected and anonymous readback/revocation |
| Multi-tenant isolation | RUNTIME PROVEN | Outsider gets 404; not a penetration test |
| Audit logs | RUNTIME PROVEN | Persisted activity and browser human descriptions |
| Graceful degradation | RUNTIME PROVEN | No-provider state; outage readiness check |
| Responsive browser workflow | RUNTIME PROVEN | Critical path and walkthrough; not full WCAG |
| CI | VERIFIED FOR PRE-C2 SHA | Hosted evidence for 368819a; uncommitted C2 diff locally verified only |
| Worker recovery | PARTIAL | Same-job transient retry and queued restart runtime-proven; forced-stop/lock-expiry recovery unverified |
| Observability | PARTIAL | IDs correlate logs and persistence; no platform/metrics tracing |
| Graceful active-job shutdown | PARTIAL | Active SIGTERM drain and waiting-job isolation runtime-proven; deadline overrun not runtime-proven |

## Phase 2G-B Retrieval and UX Evidence

### Retrieval Path and Contracts

- `packages/rag-engine/src/retriever.ts`: `HybridRetriever.retrieve` attempts
  query embedding, runs the independent candidate strategies, calls
  `fuseCandidates`, hydrates candidates, sorts fused relevance, applies
  `maximalMarginalRelevance`, then applies the token budget.
- `packages/rag-engine/src/pgvector-store.ts`: `search` returns non-null embedded
  rows ordered by cosine distance with raw score `1 - distance`. A VECTOR hit
  means this query returned the row, not that semantic relevance was validated.
  `searchLexical` uses English FTS OR queries from sanitized identifiers and
  `ts_rank` over the generated weighted search vector. Import metadata and
  conventional paths supply the other two strategies.
- Each source normalizes `max(0, rawScore) / max(sourceMaximum, epsilon)`;
  weights are VECTOR 1, LEXICAL .85, IMPORT_GRAPH .55, CONVENTION .6.
  IDs are fused once, retaining every contributing source and raw vector/lexical
  score. Each additional contributing strategy uses `max(existing, weighted)
  plus .12`, in the fixed strategy order. This is not a probability or RRF;
  agreement can produce fused scores above 1. Negative cosine remains in
  `vectorScore`, but contributes zero negative relevance.
- MMR seeds the highest fused-relevance candidate from the sorted input, then
  maximizes `lambda * relevance - (1 - lambda) * maxSimilarityToSelected`.
  Same-path similarity is .9; equal-length stored embeddings use cosine;
  missing/mismatched embeddings use identifier-token Jaccard overlap. The
  maximum penalty starts at zero, so negative similarity supplies no reward.
  Equal objectives preserve input order; equal database relevance is not a
  promised cross-query ID ordering. The query embedding argument is unused in
  MMR: fused relevance already represents query relevance.
- If query embedding fails, vector search is not invoked. Lexical, graph and
  convention retrieval remain available, without invented VECTOR evidence.
- `apps/api/src/rag/rag.service.ts`: `buildPrContext` retrieves per changed file
  and a separate repository overview. `persistRetrievedContext` snapshots
  chunk identity/path/symbol/kind/content/lines/tokens, fused score, raw
  vector/lexical scores, source labels, rationale, file association and selected
  rank. Scores are rounded to four decimals before persistence. The stored
  score is fused relevance, not the transient MMR objective; rank records MMR
  selection order. Neither embeddings nor candidate counts are persisted.
  `getRunContext` selects the authoritative run; GET
  `/pull-requests/:id/rag-context` exposes full snapshots. Review-session readback
  exposes a compact context summary from the same authoritative run via
  `AnalysisReportService` and `summarizeRagContext`.

### Deterministic and Runtime Proof

Eight focused tests were added to `retriever.test.ts`: overlapping IDs/source
preservation, intentionally disparate score scales, all four sources, lexical
fallback, lambda=1 relevance order, diversity selection, fewer-than-k/empty,
missing/mixed embeddings and defined ties (some cases share one test).
The existing negative-score test remains. RAG total: 17 tests.
The normalization case ranks vector-only B (.875) above lexical-only C (.765)
despite raw scores .7 versus 900; overlapping A is one result with both sources.
The diversity test must choose A/C rather than A/B and would fail if MMR were
bypassed.

Runtime used only `codelens_phase2f_20260930`, PostgreSQL/Redis volumes with that
project prefix, and ports web 23000/API 24000/ML 28000. The mounted,
NODE_ENV=test/project-guarded `apps/api/test/retrieval-evidence.cjs` is excluded
from images by `.dockerignore`. It creates synthetic fixtures in a separate
repository, uses real PgVectorStore/HybridRetriever queries, and removes its
repository and temporary demo-repository chunks in cleanup. Only its test
process substitutes deterministic 1536-D query embeddings; no production hook
or provider configuration is installed.

Final runtime fixture IDs: `mechanics-mup0cmo3-{A,B,C,N}`.
Candidate counts: VECTOR 4, LEXICAL 1, IMPORT_GRAPH 3, CONVENTION 1; fused IDs 4.
A retained all four source labels, raw vector 1, lexical .6383, fused 1.36.
B had vector/import sources, raw vector .9992, fused 1.1192; C had vector/import
sources, raw vector .5, fused .67. Lambda=1 selected A/B; lambda=.5 selected A/C.
After A, marginal objectives were approximately B .06 and C .085. N retained
raw vector -1 with fused relevance 0. Controlled embedding failure returned
no vector candidates or vector provenance.

A new BullMQ job produced run `cmup0cmqp0003pr01hhij39yr`, persisting 22 context
snapshots. Full context API readback matched every persisted source/raw/fused
score and selected the same run as the review-session API. Across those rows,
all four source strategies survived; negative raw vector similarity remained
auditable with nonnegative fused relevance, and IDs/ranks matched exactly.
The production worker was stopped only
in this isolated project while the test worker consumed the job and was restored
in finally. The queued run used the real pipeline with a test-only embedding
provider; it is not real-provider or semantic-quality evidence.

Hybrid and MMR independently: IMPLEMENTED, AUTOMATED-TEST PROVEN, RUNTIME PROVEN
for mechanics. Semantic quality: UNVALIDATED. Synthetic vectors prove neither
optimal context nor improved review quality, retrieval benchmarks or scale.

### Browser Proof and Correction

`critical-path.mjs --evidence-closure` runs a focused browser mode, refusing all
URLs except the isolated pair and intercepting off-target API requests before
delivery. User interaction uses Tab/Enter/Space/Home/End/type only, not mouse,
locator focus or click. Chromium/installed Chrome at 1280x900 exercised sign-in,
PR navigation, review workspace, fresh Analyze, comments, both verdict controls,
share creation/copy and closing the inline share panel. Critical controls had
visible computed focus styling; no unexpected focus trap or unnamed visible
icon-only button was found. This is keyboard-path sanity, not WCAG certification
or screen-reader/contrast/mobile accessibility coverage.

Browser clipboard interception proved FULL -> SUMMARY -> FULL creates/copies
each newly returned URL exactly, not a previous URL; passphrases are absent from
the URL. Values are compared in memory and never printed. Test links were revoked
in finally. No JS or unexpected network errors remained in the final runs.

Demonstrated product defect: clipboard rejection originally caused one uncaught
JS error and no feedback. The only production correction is
`share-panel.tsx`: catch denial/unavailable clipboard, display truthful manual-copy
feedback, reset copy confirmation for each new link, discard stale asynchronous
copy settlements, and clean up the confirmation timer. The browser mode proves
successful copies and denial feedback without uncaught errors on the rebuilt
isolated web image.

Controlled isolated ML outage: fresh run `cmup050k0001cs901fysaz63u` COMPLETED;
prior run `cmup02vva0001s901pjje2api` had score 91, current risk was null, not zero
or stale. UI displayed "No risk prediction" and the run-specific no-score
explanation, with no ML-score heading. Four static findings and nine RAG context
rows remained. AI was SKIPPED with matching UI (no provider key configured).
Gate remained blocked without stale risk-score warnings; Analyze and collaboration
controls remained keyboard-usable. ML was restored in finally and health checked.
Both normal and outage browser flows also passed the copy/keyboard checks.

Verification setup correction: the first web rebuild omitted the isolated
NEXT_PUBLIC_API_URL build argument and sign-in timed out due to the default
API URL. The corrected build explicitly used localhost:24000/api/v1. Read-only
original-database checks found zero recent `user.logged_in` events and unchanged
demo-owner lastActiveAt (2026-09-24); no successful original sign-in occurred.
The browser guard now blocks wrong-origin calls before delivery. This was an
isolation build-command error, not a production feature defect. No original
container, volume, schema or data was intentionally modified.
The explicit build argument is retained in the ignored local
`.compose.phase2g.local.yml` override; that verification-only file must not be
committed.

Final local checks: root pnpm test 90 passed (database 6, static 11, RAG 17,
AI 18, API 38); workspace typecheck, RAG build, web build and isolated web image
build passed. Focused real retrieval/queue/readback and both browser runs passed.
JavaScript syntax checks and git diff --check passed.
No API production change required an API rebuild. Applied 0_baseline is unchanged.
Read-only source hashes matched the checkout for API/worker retrieval and the
deployed web copy correction. The isolated web image digest was
`sha256:8be1edd78f3a75e016eecbbecfce8039b543f44cec05617cf6b4bc7ceda85ddd`;
API image `sha256:4d03144ea680b3f4bda80e3c3bb9582e968dfecb6e9ea305efc1de3b08f5a280`;
worker image `sha256:7525bfdabe8f13f7f3452b7ce041fe66105c7b1989902d82609f965ae259064e`.
No provider credentials, local isolation files or generated browser artifacts
are commit content. Prettier/Ruff debt and external GitHub/provider/hosted-CI
boundaries above remain unchanged. No Phase 2G-C work or commit is claimed.

## Phase 2G-C1: Synthetic Credential Safety (2026-10-01)

Base commit: `bd6c562fa7e7bacb232165b07e5696ada330df3e`. No real credentials or
external GitHub/provider requests were used. The original Docker project and
`0_baseline` were not modified.

OAuth previously signed `{ nonce, issuedAt, ...payload }` using HMAC-SHA256 and
accepted it for ten minutes, but did not bind it to a browser or consume it.
The corrected state includes immutable nonce/issued/expiry fields. Redis holds
a ten-minute record containing local user/generation/organization context and
the SHA-256 binding of a random HttpOnly browser-cookie value plus the initiating
refresh cookie. A single Lua operation checks the binding and deletes the record.
Wrong-browser/session callbacks do not consume a valid record. Redis errors fail
closed, unlike best-effort cache helpers. Replay/denial requires a fresh flow.
Local link mode requires a valid, non-revoked refresh session; optional access
identity must match. Callback rechecks local token generation. Sign-in no longer
auto-links a different GitHub identity merely because its email matches a local
account. New account creation uses only verified GitHub email addresses.

The callback sets the existing HttpOnly refresh cookie and redirects to the fixed
`/auth/callback` route with an allowlisted outcome, never an access-token fragment.
Frontend session recovery uses `/auth/refresh` and `/auth/session`; success is
shown only for an authenticated connected account. Denial/invalid/provider failure
have fixed messages and retry/sign-in navigation. Arbitrary redirect targets and
provider error descriptions are not forwarded. The outcome query is removed after
hydration. Same-site API/web deployment and HTTPS secure cookies remain required.

Synthetic tests capture exception log arguments/client bodies, nested tool metadata,
embedding indexing progress, provider errors, and browser/application diagnostics.
Query/fragment values are omitted from exception paths; recognized assignments,
bearer credentials, share URLs, known request/environment secrets and nested secret
fields are sanitized. Ordinary validation text and token-usage counts remain useful.
Upstream bodies and parser/transport messages are not error diagnostics; LLM machine
categories use an explicit allowlist. AES-256-GCM remains unchanged, with fresh
96-bit IVs, authenticated tags, strict key validation and tampering/wrong-key tests.
Local disconnect deletes stored credentials; upstream authorization revocation is
a separate operator action. JavaScript cannot guarantee plaintext memory zeroization.

`pnpm build:packages`, API/web builds, workspace typecheck and root tests were run.
The focused browser harness is `node apps/web/test/oauth-safety.mjs`, after package
and API builds. It owns dedicated loopback ports 23400/24400, uses a test-only Nest
server with fake database/GitHub/Redis dependencies and runs the real auth classes,
JWT issuance, encryption and frontend. It intercepts the backend authorize redirect
before any GitHub navigation. Success, repositories navigation, denial, replay and
invalid state passed; captured diagnostic marker occurrences were zero. It does not
dump storage/headers or produce screenshots/traces. Test drivers are excluded by
the existing Docker context rules; production entry points contain no test hooks.

### Container and Real Redis Closure

Docker Desktop access was restored using its explicit executable path and host
execution approval. A new project, `codelens_c1_20261001`, used only new volumes
`codelens_c1_20261001_postgres_data` and `codelens_c1_20261001_redis_data`.
The original project was inspected read-only, not restarted or modified.
The fresh database applied the immutable `0_baseline`; a subsequent initialization
reported managed state and no pending migrations. No demo seed was run.

API and web images built the final uncommitted production sources. Eleven source
SHA-256 comparisons matched the working tree, including OAuth state/controller,
auth, GitHub client/exchange, redactor, provider adapters and all three changed web
entry points. API image ID:
`sha256:2dbb922fc29a2dbf5ad45ecdb58909d1029fbf57e4c49a44ac7485837f992e4f`.
Web image ID:
`sha256:1729ffbfb15089567b8e0f5c691d174fe04ce12bb990bfac1d48245c469ff4f7`.
Test directories were absent in both images. Synthetic upstream responses were
supplied only by an explicitly mounted test-only preload in the isolated API.
Normal production entry points contain no preload or synthetic provider switch.
No real credentials or external GitHub/provider calls were used.

The real Redis driver exercised the compiled OAuthStateService, not a fake adapter.
Nonce TTL was 600 seconds. Correct ownership consumed once; replay, tampering,
expiry, missing nonce, wrong browser and wrong initiating refresh binding failed.
Wrong bindings left the valid record available to its owner. Sixty-four simultaneous
consume attempts yielded exactly one success and 63 rejections; the nonce was absent
afterward. These observations prove the tested Lua mechanics, not exactly-once
processing of all external side effects.

Chromium used the actual container API/web at loopback ports 34400/33400. PostgreSQL
and Redis remained on an internal-only network without published host ports.
An initial isolation-only mistake used that network for API/web too, which prevented
host access despite configured ports. Adding a host-facing network only to API/web
resolved it. The browser intercepted the API authorize redirect before GitHub
navigation; the API preload blocked unmatched external fetch requests.

Real database/Redis callback completion, HttpOnly refresh-cookie recovery, connected
UI and repositories navigation passed. Denial, invalid state and replay produced
fixed frontend states; the hydrated callback URL was `/auth/callback`, with no query
or credential fragment. The production-mode browser-binding cookie was HttpOnly,
Secure and SameSite=Lax. Loopback acceptance of Secure cookies does not replace
deployment HTTPS requirements.

Verified email matching an existing local user was rejected for anonymous linking;
the authenticated owner then explicitly linked that identity. An unverified email
did not create/link a user. A new verified identity created a separate user/account.
Mismatched access/refresh local identities were rejected. Final state had three
synthetic users and two GitHub accounts, with the expected owners; replay introduced
no additional account. Both persisted credentials were encrypted, decrypted through
TokenCryptoService to their intended synthetic values, and re-encryption produced
distinct ciphertexts and IVs. This proves AES-GCM mechanics, not HSM key management.

Stopping only isolated Redis made initiation return HTTP 500 and a previously issued
callback redirect to the fixed invalid outcome. A repeated outage check compared
Account IDs, owners and encrypted credentials before/after: unchanged. Redis was
restored and responded PONG. No unbound-state fallback or partial account was created.

Unique code/state/authorization/provider-body/provider-code markers were exercised.
Browser diagnostics and returned errors had zero occurrences. A container script
used the compiled RagService, real Prisma/Redis/vector store and AuditService with
synthetic source/policy dependencies: rejected embedding requests persisted sanitized
errors into IndexRun, Repository and audit rows. Compiled OpenAI/Anthropic LLM adapters
also rejected marker-bearing bodies safely through the normal tool logger. No new
queued AI review or LLM ToolRun persistence is claimed by that script. Captured API
and web logs (180/8 lines at the recorded scan) contained zero supplied secret markers.

Final root regression: 120 tests passed (API 55, RAG 19, AI 21, GitHub 7, static
analysis 11, database 6, shared 1). Workspace typecheck, API/web builds, isolated
Docker API/web builds and diff whitespace checks passed. Container drivers:
`apps/api/test/oauth-redis-runtime.cjs`, `oauth-diagnostic-runtime.cjs`, and
`apps/web/test/oauth-container.mjs` (full mode requires initially unconnected C1
fixtures; `--outage-only` repeats outage/account verification). They require explicit
C1 isolation configuration, not the default Compose project.

LIMITATIONS: No real OAuth, real provider, universal secret non-leakage, penetration
test or complete security audit is claimed. Proxy/access logs and arbitrary
unrecognized secrets require separate deployment review. Parallel OAuth tabs/session
refresh changes can invalidate an earlier flow and require retry. Real external
GitHub/provider proof remains EXTERNAL-CREDENTIAL BLOCKED. This narrow project does
not include ML or a worker and does not establish new analysis/retrieval evidence.

## Phase 2G-C2: Real External Integration (2026-10-02)

**Real GitHub: VERIFIED for the tested OAuth/read-only integration path.**
**Real Gemini: VERIFIED for native embeddings and structured review generation.**
Only isolated Compose project `codelens_c2_20261001` was used, with its own
PostgreSQL/Redis volumes and loopback web/API ports 43400/44400. The original
CodeLens project/data and immutable `0_baseline` were not changed. No demo seed,
token minting or database authentication bypass supplied this evidence.

### Source and Provider Evidence

Public fixture: `abhi02max/codelens-integration-fixture`, open/unmerged PR #1,
base `main`, head `7f1fb3502d435adfa901dc14569aa2893a0945bd`. Imported diff and
persisted metrics agree: three files, +10/-2, twelve changed lines. Real GitHub
OAuth completed with only `user:email`; the callback URL was cleaned. The connected
account's token was encrypted at rest and authenticated decryption was verified
in memory without printing it. Earlier C1 synthetic concurrency/safety proof is
retained and is not relabelled as new real-GitHub concurrency evidence.

Index run `cmupgnskt0001qp01b0b9zx68` completed through the real queued worker:
three chunks, all three with non-null 1536-D `gemini-embedding-2` vectors.
Chunk paths: README.md, src/orders.ts, tests/orders.test.ts. Indexing used main,
not a copy of an existing database or the PR head. A real query embedding and
retrieval succeeded. src/search.ts is PR-added, so its absence from main's index
is expected, not a missed file. The public fixture alone was sent externally.

The first OpenAI embedding attempt returned HTTP 429; the user confirmed zero
credits. OpenAI remains **CREDIT-BLOCKED**, not externally proven successful.
The first Gemini review using `gemini-2.5-flash` returned non-retryable HTTP 404;
its PARTIAL run remains historical evidence. One separately approved read-only
model catalog succeeded, but catalog presence did not prove generation access.
After explicit approval, the saved model and isolated API/worker configuration
were changed to `gemini-3.8-flash`; the existing embeddings were retained.

Successful queued run `cmuqhref50001of01g2jtw1ev` completed at
2026-10-02 04:57:59.394 UTC in 46.748 seconds, with all four evidence flags true.
Ten tools succeeded; GitHub posting was skipped. AiReview persisted provider
`GEMINI`, model `gemini-3.8-flash`, REQUEST_CHANGES, three findings, three file
explanations and two suggested tests. Persisted review content passes the shared
AiReview schema. Security anchors are src/search.ts:2 and src/orders.ts:4, both
changed lines; the testing observation is tests/orders.test.ts:6, an existing weak
assertion rather than a newly added line. All cited ToolRun IDs belong to this run
and succeeded; that validates provenance, not the truth of every model claim.
Suggested tests were persisted/displayed, **not executed**.

Four RetrievedContext rows survived report persistence, all referencing the README
chunk: vector-only overview and per-file vector/lexical/convention combinations.
Repeated chunk IDs across different retrieval targets are not four unique chunks.
This proves retrieval/persistence mechanics, not optimal ranking or code-context
quality. ML persisted OK, risk 10, xgboost/bootstrap-v1, isBaseline=true. Report
output risk 9.9 is rounded to 10 in persistence/readback; it is weak synthetic/
bootstrap evidence, not a trained organization risk model. Report flags/counts,
AiReview, PrMetrics, MlPrediction and context rows agree. The workspace displays
the completed Gemini review, anchors, RAG, baseline caveat and report metrics.
Started/completed and tool audit records read back in the workspace. The tool
audit's nine-success count is a snapshot before the audit tool itself completes;
the final pipeline has ten successes, not a missing tool record.

### Static Analysis: Expected Coverage Gap

The recorded input contains all three complete small fixture patches. Secret scan
and pattern scan each processed three files successfully and reported zero findings.
ESLint was SKIPPED (no repository config), Semgrep NOT_INSTALLED in the worker,
and npm audit SKIPPED (no changed manifest). Host Docker availability does not make
the Semgrep binary or a Docker fallback available inside the worker container.
The fallback SQL rules match Prisma raw-query calls, not a generic concatenated
SQL-returning function; no rule models removal of this array's tenant filter or
the inadequacy of these assertions. Zero findings is therefore expected limited
coverage, **not proof of secure code** and not an input/anchor regression. No static
rules were invented or broadened for this fixture. C2 does not prove Semgrep or
deterministic detection of the two intended security hazards; AI identified them.

### External Writes and Credential Safety

Retained Redis job data has `postToGithub=false`; the posting tool is SKIPPED with
"Not requested for this run", and there are zero GitHub-comment-posted audit rows.
Read-only public GitHub verification shows the same open/unmerged head, zero issue
comments and zero inline review comments. The sole review is a prior Copilot bot
COMMENTED review (ID 5377713105, 2026-10-01 09:53:12 UTC), not CodeLens. No CodeLens
merge, branch update, comment or review was performed. GitHub writes remain untested.

In-memory scans of captured isolated API/worker/web logs and all tracked/proposed
source files found **zero supplied credential-value matches**, including the
decrypted GitHub token and configured runtime keys/passwords. Raw logs, provider
responses and credentials were not printed. This is scoped exact-value evidence,
not universal secret non-leakage, historical/proxy-log safety or penetration testing.
Local env/Compose files and `.codelens-tmp` remain ignored and Docker-excluded.

### Local Regression and Remaining Boundaries

Final local checks: 138 tests passed (API 61, RAG 29, AI 23, static 11, shared 1,
GitHub 7, database lifecycle 6); Prisma validation/generation, package/API/web builds,
workspace typecheck and diff whitespace checks passed. An initial typecheck raced
Next build's generated types; the sequential post-build rerun passed. No source fix
or mass formatting was applied for that generated-artifact race.

Product changes are limited to native Gemini embedding support, truthful compatible
review service identity, failed indexing queue outcomes, and persisted index metadata.
No test double enters normal runtime. Gemini reviews still select the OPENAI protocol
adapter with Google's exact compatible base URL; configure its OPENAI_API_KEY slot
locally with the Gemini key and GEMINI_API_KEY for native embeddings. The endpoint
identity fix does not infer Gemini from arbitrary/lookalike hosts. No Gemini provider
enum or schema migration was added. Native embeddings currently support only
gemini-embedding-2 and use explicit 1536 dimensions here; arbitrary model/dimension
combinations are not proven. Changing embedding models on populated indexes needs a
deliberate compatible re-index; mixed-model retrieval quality is not claimed.

Costs shown in the UI use existing generic estimates for unrecognized models;
they are **not actual Gemini billing/free-tier charges or quota guarantees**.
Semantic review/retrieval quality, generated-test correctness, real-provider repair/
retry failure injection, GitHub writes/webhooks/private-repository scopes, other AI
providers, and hosted CI for the new diff remain unverified. Earlier partial-run
gate/context wording and stale summary-header observations remain disclosed in the
local attempt inventory; C2 does not claim those UX paths were corrected. Prettier/
Ruff debt, deadline-overrun/SIGKILL recovery, exactly-once guarantees and exhaustive
accessibility/security testing remain outside the proven boundary.

## Phase 2G Release Certification and Scoped Fixes

The clean audit examined exact SHA
`5814bd8c51159c6d2ea88f20ed4d22a943ed1571` in a separate detached checkout.
Frozen installation, 138 workspace tests (including 61 API tests), 11 Python
contracts, Prisma validation/generation, sequential typecheck, production builds,
and exact-SHA hosted CI passed. API tests were also run separately; those are not
61 additional distinct tests. Fresh empty-volume initialization applied 0_baseline
without seeding, repeat initialization was managed/idempotent, and explicit seed
and normal restart passed. PR #412 retained four files, +26/-5, 31 changed lines.
One credential-free live run persisted four findings at 58/59/69, ML baseline risk
91, and nine context rows; AI was truthfully skipped. Certification resources were
removed without touching the original or C2 projects. No external provider calls
were repeated. Prior real GitHub/Gemini evidence remains independently scoped.

That revision was **NOT RELEASE CERTIFIED**: `pnpm test:browser` failed before
login because substring matching for Sign in also selected Sign in with GitHub.
The walkthrough had the same ambiguity, including its hydration selector. Manual
credential login succeeded; no product authentication defect was established.

The uncommitted correction uses exact accessible button names in both scripts.
The credential button becomes visible under its Sign in name after hydration;
the enabled-state assertion remains. GitHub sign-in is separately selected by its
exact name and checked without invoking OAuth. No authentication implementation,
assertion removal, or new test identifier is involved.

Only four newly added TypeScript files were formatted: repo-index.processor.test.ts,
rag.service.test.ts, gemini-embeddings.test.ts, and gemini-embeddings.ts. Each is
exactly the pinned formatter's output from its committed content; syntax-tree
comparison preserves semantics, ignoring redundant expression parentheses.
Canonical tracked-content counts: parent **142**, 5814bd8 **146**, corrected tree
**142**. No existing baseline formatting failure was removed. CRLF checkout counts
are not used to claim a formatting regression or a clean repository. Ruff's nine
historical findings remain disclosed; no Python source or tooling was changed.

Fix-pass browser verification used a new disposable project
`codelens_certfix_5814bd8_20261002`, ports 53400/54400, explicit demo initialization,
and the runbook's live PR #412 analysis before `pnpm test:browser`. External keys
were blank. The critical path passed with 108 API requests, zero JS/network errors
and four navigation cancellations. The walkthrough passed **83 checks, zero
failed**. Invalid login, valid credential login, hydration, separately selectable
GitHub sign-in, refresh, logout and protected-route behavior were exercised.
GitHub OAuth itself was not invoked or re-proven.

The walkthrough also recorded two 401 resource console messages on sign-in and
two advisory text-clipping detections on existing line-clamped activity summaries.
These diagnostics were not suppressed or converted into passing assertions; the
existing command's exit criteria were unchanged. No clipping/auth product change
was made, and this is not an exhaustive visual/accessibility certification.
Targeted tests passed 16/16; the workspace suite passed 138/138. Python contracts
passed; Ruff still exited nonzero with its nine unchanged findings.
Prisma validation/generation, package/API/web production builds, sequential
workspace typechecks both before and after the build, and `git diff --check`
passed for the corrected source. 0_baseline remained byte-for-byte unchanged.

Hosted CI for these uncommitted corrections and exact-revision release
re-certification remain **UNVERIFIED**. Local fix-pass evidence does not certify a
future commit, semantic retrieval/review quality, universal recovery, exactly-once
effects, exhaustive accessibility, or universal secret non-leakage.

## Phase 3C: Deterministic Collaboration Evidence

The uncommitted Phase 3C implementation on `c54ba797bc34b441e4a7e638a26f613631d46dd7`
connects persistent conversations to bounded asynchronous provider/tool execution.
See [the implementation and evidence report](phase3c-collaborator.md) for the exact
38-file inventory, state machine, protocol, budgets, API, isolated runtime evidence,
adversarial corrections and remaining boundaries.

Local evidence: 317 workspace tests, Prisma validation/generation, sequential
typecheck and production package/API/worker/web builds passed. Real isolated
PostgreSQL/Redis/BullMQ proved queued execution, persisted citations and follow-up,
tenant isolation, bounded fake-citation repair, provider/RAG degradation,
cancellation late-write rejection, managed upgrade and fresh migration lifecycle,
historical-head readback and full-row restart persistence. The provider and GitHub
reads were explicit mounted deterministic test boundaries, not real external calls.
Focused browser proof passed 13 normal and 3 historical checks. The existing
walkthrough retained its pre-existing 91/CRITICAL versus seeded 78/HIGH drift:
81 checks passed, two failed, with two expected sign-in 401 diagnostics.

The separately approved real-Gemini attempt called `gemini-3.8-flash` four times:
three HTTP 503 responses and one HTTP 200 response with `finish_reason=tool_calls`
and no JSON message content (native payload fields were not captured). The bounded
engine stopped at `FAILED / PROVIDER_BUDGET`, preserving the
human question and persisting no assistant/tools/evidence. Failure readback and
scoped credential checks passed; further paid calls stopped. Successful real
collaboration, follow-up and real-provider injection/citation behavior remain
unverified. The full report preserves this failed attempt and its exact counters.
Prior Phase 2 real Gemini review evidence is not invalidated or expanded by this
separate collaboration attempt. No product workaround or provider switching occurred.
Follow-up classification is **D: NOT PROVEN**: the capture omitted native tool-call
fields/arguments, so finish reason alone cannot prove valid tool requests or an
adapter defect. No additional real request occurred. Two diagnostic tests passed
with 61 AI / 110 API targeted cases. Four requests and 6,008 reserved units reconcile;
`providerRetries=3` currently counts retryable failures, not executed retry requests
(two transient retries actually ran). That counter-semantics concern remains
disclosed without production changes or relaxed budgets. The full report describes
the proposed separately approved single-request structural diagnostic.
A subsequent separately approved **single POST** returned HTTP 200 / `stop` with
122 bytes of normal JSON content validating as `REQUEST_TOOLS`; native tool-call
fields were absent. This diagnostic is **A: NORMAL JSON-IN-CONTENT RESPONSE**, not
successful end-to-end collaboration. No tools, repair or second provider request
ran. Raw payloads were not retained, and isolated runtime was restored to
credential-free configuration. The prior anomaly did not reproduce and its missing
fields remain unproven. Production parsing and retry-counter semantics are unchanged.

The final separately approved normal queued attempt used a fresh conversation
`cmus0e21o0003o801mkc80cqs`, turn `cmus0e24e0007o801gx7jgb27`. Five real Gemini
requests returned 200/503/200/503/200; three valid JSON-content tool-request actions
executed five Phase 3B tools and persisted thirteen scoped references (eight
SNAPSHOT file/diff references and five DERIVED report/static references). Selected
persisted evidence reached subsequent provider contexts, at most 11,760 bytes.
The fifth request requested further investigation, not a final answer; the engine
stopped at FAILED / PROVIDER_BUDGET after 58,533 ms, with 4,382 reserved/charged
output units, two observed retryable failures, zero repairs and three rounds.
No assistant/citations persisted and no follow-up was submitted. No native anomaly
or production defect was established. Tool/persistence/context mechanics are now
real-provider runtime-proven; grounded final answer, real citations and multi-turn
success remain unverified. All thirteen individual evidence endpoints and scoped
DB/audit consistency passed; browser failure/reload was truthful. Scoped credential
checks found zero supplied-value matches; API/worker were restored credential-free.
Relevant deterministic regressions rerun: 61 AI and 110 API tests passed. The full
report preserves all earlier attempts and metric semantics. No additional paid
campaign, production fix, commit, GitHub mutation or Phase 3D work followed.

Accepted Phase 3C status:

- Phase 3C deterministic verification: **PASSED**
- Real Gemini investigation/tool/evidence path: **PARTIALLY VERIFIED**
- Real Gemini final grounded response/citation path: **NOT VERIFIED**
- Real Gemini multi-turn collaboration: **NOT VERIFIED**

No successful final Gemini RESPOND, real-provider final citation persistence,
real-provider semantic answer quality, real-provider multi-turn follow-up or full
real-provider pass is claimed. The user accepted these limitations for commit.
Citation validation is mechanical; cancellation does not guarantee remote billing
stops; crash/deadline recovery is test-proven, not host-level runtime certification.
Canonical Prettier debt remains 143 files before/after this diff; unchanged Ruff
debt, older clipping observations and other previously disclosed limits remain.
Existing migrations are unchanged. No GitHub mutation or Phase 3D implementation
occurred. Hosted CI and exact-revision certification of this diff remain unverified.

## Phase 3D Prerequisite Foundation (Not Patch Proposals)

On baseline `3cdc6e9c67f1b7db30b54b46281e3447a59d8a99`, the prerequisite-only
adjustment adds nullable `CollaborationTurn.baseSha` through
`20261003010000_exact_revision_foundation`. There is no default or backfill;
historical nulls remain null. New turns capture head/base together from one
server-derived PR response. Missing upstream base remains null; malformed supplied
base fails closed. Message replay returns the original pins without rereading PR
metadata. Client message contracts cannot supply authoritative SHAs. Ordinary 3B
reads and the 3C protocol/budgets are unchanged; future proposal validation must
reject absent required exact revision metadata, not invent it.

`GithubClient.verifyExactFile(fullName, path, revision, options)` is a stronger
read-only internal primitive, separate from existing contents/search APIs. It
walks nonrecursive Git trees from a full commit SHA, retaining each selected
component's type/mode/object SHA. It distinguishes REGULAR_FILE, DIRECTORY,
SYMLINK, SUBMODULE and UNSUPPORTED, stops at non-directory intermediate entries,
and never follows symlinks/gitlinks. Only `100644` regular UTF-8 blobs with verified
Git blob identity are modification-eligible; executable `100755` blobs are
classified as regular but ineligible. Metadata-only reads are also ineligible.
Paths reuse the 3B validator plus stricter `.git`, device-name, trailing-dot/space,
depth and case-ambiguity exclusions. Missing paths and truncated/inconsistent trees
fail closed. Repository scope is bound by the authorized caller, not model input.

Bounds: 16 path components (at most 16 nonrecursive tree reads, one commit and one
blob read), 10,000 entries per tree response, 1 MiB decoded blob bytes and a
15-second overall abort deadline. Requests propagate cancellation, use 15-second
wire timeouts and do not add automatic retries. These are response-contract/local
validation guarantees, not independent cryptographic verification of upstream
commit/tree serialization or a hard streaming network-byte cap. Git blob bytes
are independently hashed before eligibility. No real GitHub behavior beyond the
deterministic tested response contracts is claimed.

Runtime proof used only new project `codelens_phase3d_foundation_20261003`, volume
`codelens_phase3d_foundation_20261003_postgres_data`, with no published host ports.
Fresh normal db-init applied all five migrations; all 35 application tables were
empty afterward. Repeated db-init detected managed state with no pending migration.
A separate database in the same new container was initialized through 3C and
explicitly demo-seeded, then upgraded: existing-column fingerprints for all 35
tables matched, historical conversation/message/turn sentinels survived with null
base, and invalid base was rejected by the database constraint. A focused runtime
proof used the newly built turn service and generated Prisma client against real
PostgreSQL with deterministic read-only PR metadata: paired pins persisted, replay
preserved them after cached base changed, historical null readback and foreign-tenant
denial passed. This is not a new deployed HTTP/worker/browser verification claim.

Prisma validation/generation, package builds, sequential workspace typecheck and
API/worker-entry/web production builds passed. Workspace regressions passed:
**372 tests** (shared 1, AI 79, GitHub 57 including 44 verifier cases, database 16,
static analysis 11, RAG 29, API 179 including 42 conversation cases). The existing
23-case execution suite was rerun after strengthening its pin-preserving retry
assertion and passed. Formatting comparison remained 143 before/after, with no new
failures; `git diff --check` passed.
All four older migrations remain byte-identical. Ignored local Compose/proof files
are excluded from production images and proposed commits. No provider request,
GitHub mutation, PatchProposal, PROPOSE_PATCH, proposal UI, patch execution or Phase
3E behavior was introduced. Known walkthrough/formatting debt and accepted 3C
real-provider limitations remain unchanged. Hosted CI for this uncommitted
prerequisite diff is not claimed.

## Completion Estimate

Approximately 90% portfolio complete is a judgement, not a coverage calculation.
Core product: roughly 95%; engineering/reliability: roughly 85%; external
verification: scoped GitHub/Gemini path proven, not universal integration quality.
Optional commercial features (SSO, IDE,
additional hosts/integrations) are outside this portfolio definition.

100% means a stranger can follow documented setup/demo, pass canonical checks and
hosted CI, reproduce recovery/readiness, and inspect one controlled real GitHub
and provider run, with limitations stated honestly. It does not mean commercial
scale, certifications or feature parity with established review vendors.
