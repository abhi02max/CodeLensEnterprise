# @codelens/api

NestJS REST API and background workers for CodeLens Enterprise. Serves `/api/v1`, orchestrates
the eleven-tool review pipeline, and hosts the BullMQ consumers.

## Running it

Dependencies first — Postgres with pgvector, Redis and the ML service all come from
`docker compose up -d postgres redis ml-service` at the repo root.

```bash
pnpm --filter @codelens/api build
pnpm --filter @codelens/api dev      # watch mode, workers in-process
pnpm --filter @codelens/api worker   # dedicated worker process
```

Swagger is at `http://localhost:4000/docs` outside production. Health is at
`/api/v1/health`, and it distinguishes dependencies the product needs from ones it degrades
without: Postgres and Redis are `required`, the ML service and the LLM provider are not.

### Deployment shapes

`RUN_WORKERS_IN_API` chooses between the two:

| Value | Layout | Use |
| --- | --- | --- |
| `true` | One process serves HTTP and consumes queues | Local development |
| `false` | API serves HTTP only; run `pnpm worker` separately | Production |

Split them in production. A full analysis is minutes of subprocess and network work, and
sharing an event loop with request handling makes the dashboard slow for everyone whenever
someone triggers a review.

`pnpm worker` always consumes regardless of `RUN_WORKERS_IN_API` — the flag describes whether
the *API* should double as a worker, and the production setting of `false` is precisely why the
worker process exists. It does not read the flag to decide whether to work; see
`src/queues/worker-mode.ts` for why that decision cannot go through configuration.

## Long-running operations

Three operations are queued rather than run inline, because none of them fits in an HTTP
request: analysis, repository indexing, and organization-wide GitHub sync.

```
POST /api/v1/pull-requests/:id/analyze     -> 202 { mode: "queued", job, pollUrl }
POST /api/v1/repositories/:id/index        -> 202 { mode: "queued", job, pollUrl }
POST /api/v1/repositories/sync             -> 202 { mode: "queued", job, pollUrl }

GET    /api/v1/jobs/:id                    job state, progress and result
DELETE /api/v1/jobs/:id                    cancel a job that has not started
GET    /api/v1/jobs/queues                 depth, consumers and head-of-queue age (ADMIN)
```

Analyze and index also accept `sync: true`, which runs inline and returns the finished result.
That is for small inputs and for verification; a large pull request will outlive the HTTP
timeout.

### Job handles

A job id looks like `review-run:analyze-<pullRequestId>-<headSha>`. The queue is encoded into
the handle so one endpoint covers every queue and clients never need to know the topology.
Percent-encode it when building a URL; `pollUrl` in the response already is.

Job ids are deterministic, so enqueuing the same analysis twice returns the first job with
`deduplicated: true` rather than paying for it again. `force: true` produces a distinct job.

Note that BullMQ forbids `:` inside a custom job id, which is why the id components are
hyphen-separated even though the handle itself uses a colon.

### Polling

`GET /jobs/:id` reports `state`, `progress.percent`, `progress.stage` and, for analysis jobs,
`progress.reviewRunId` as soon as the run row exists. Switch to
`GET /review-runs/:runId` at that point: it exposes per-tool status, which the job cannot.

A completed job does not mean a successful review. The pipeline degrades rather than failing
when an optional dependency is missing, so check `result.status` and `result.degradation`. A
run whose *critical* tool failed reports `state: "COMPLETED"` with `result.status: "FAILED"` —
the job did its work; the analysis is what failed, and retrying it would not help.

### Retries

A job only retries when running it again could plausibly change the outcome. Missing
resources, validation failures, policy violations, a missing GitHub connection and rate limits
are classified as unrecoverable and fail on the first attempt, so the real error reaches the
user immediately instead of after three backoffs. See `classifyJobError` in
`src/queues/queue.service.ts`.

## Review sessions

A review session is the PR review workspace. **There is no `ReviewSession` table**, and the
session id *is* the pull request id. A session is a view over rows that already exist:

| Part of the session | Backing rows |
| --- | --- |
| analysis state | latest `ReviewRun` + its findings, prediction, AI review, tool runs |
| human verdicts | `Review` (one per reviewer per head SHA) |
| discussion | `Comment` threads |
| external sharing | `ShareLink` |

Adding a fourth table to represent the composition of three existing ones would put review state
in two places, and they would disagree the first time a run was re-triggered. Everything is
derived on read instead.

```
POST   /api/v1/review-sessions                              open a session, refresh if stale
GET    /api/v1/review-sessions/:id                           the full workspace
GET    /api/v1/review-sessions/share/:token                  unauthenticated shared read
POST   /api/v1/review-sessions/:id/approve
POST   /api/v1/review-sessions/:id/request-changes
POST   /api/v1/review-sessions/:id/share-link                ADMIN+
GET    /api/v1/review-sessions/:id/share-link                ADMIN+
DELETE /api/v1/review-sessions/:id/share-link/:shareLinkId   ADMIN+
```

`POST /review-sessions` is a POST rather than a GET because it can cause work: when there is no
analysis, or the latest run predates the current head, it queues one and returns the job
alongside the workspace.

### The merge gate

`gate` is computed from the org's review policy on every read, so tightening the policy
immediately re-evaluates every open pull request. The split between blocking and advisory
follows what each policy field claims to do:

- **Blocks**: `minApprovals` (raised to at least 2 when the change touches auth, payment,
  database or infrastructure code and `sensitiveFlagsRequireTwoApprovals` is set), any
  outstanding CHANGES_REQUESTED at the current head, unresolved findings at or above
  `blockingSeverity`, detected secrets, and missing tests on a change of 20+ lines.
- **Warns**: `riskScoreGate`. A probabilistic model should not be able to veto a merge on its
  own, and a gate people cannot argue with is a gate they route around.

Verdicts are pinned to a head SHA and `stale` is derived, never stored — a new commit
invalidates every outstanding approval with no migration or background job.

An author cannot approve their own pull request. That is not a role question, so it is enforced
in the service rather than in a guard.

### Human verdicts feed the ML models

Submitting a verdict writes `PullRequest.wasRisky`, `riskLabelReason`, `firstReviewedAt` and
`actualReviewMinutes` — the training targets for the risk classifier and the review-time
regressor. The risk label is derived from the whole review history, not the verdict just
submitted: once anyone has requested changes the change *was* risky, and a later approval of the
fixed code does not make the original safe.

`ReviewRun` is never written by this path. A human verdict is not a property of a pipeline
execution.

## Comments

```
POST   /api/v1/review-sessions/:id/comments
GET    /api/v1/review-sessions/:id/comments
PATCH  /api/v1/comments/:id
DELETE /api/v1/comments/:id
POST   /api/v1/comments/:id/resolve
POST   /api/v1/comments/:id/reopen
```

Comments anchor to the pull request, not to a `ReviewRun`: a conversation about a line of code
outlives the run that surfaced the issue, and anchoring to the run would orphan every thread
exactly when someone re-triggers analysis mid-discussion.

Three levels of anchoring, by what you supply: nothing for a general comment, `path` + `line`
for an inline one, and `findingFingerprint` to attach the thread to a specific finding.
**Resolving a finding-linked thread clears that finding from the merge gate** — that is how a
human overrides a static analyzer, visibly and with their name on it, rather than by suppressing
the rule.

Validation rejects a `path` the change never touched, a `line` without a `path`, a fingerprint
that matches no finding on this PR, and a reply to a reply. Each of those would otherwise fail
silently: an unknown fingerprint in particular would leave the thread looking resolved while the
gate stayed blocked with no indication why.

Permissions: author-only for edit (including for admins — deleting a comment and rewriting it
under someone else's name are different acts); author or ADMIN+ for delete; author or REVIEWER+
for resolve and reopen, on thread roots only.

## Share links

Time-limited unauthenticated access to one review. The only path that serves tenant data with no
authenticated actor, so it is built to fail closed:

- **Tokens are stored as sha256.** The raw value is returned exactly once, in the `url` and
  `token` fields of the creation response. Listing links returns an empty `url` because the URL
  is genuinely unrecoverable — a leaked database yields no usable links. Someone who mislays a
  URL gets a new link, which leaves a fresh audit entry naming who re-shared it.
- **The shared payload is an allowlist**, not the workspace with fields deleted. A denylist
  starts leaking the moment a field is added upstream; an allowlist fails by omitting something
  that someone then notices. Never included: tool run outputs (raw provider and analyzer
  payloads), audit entries, share links, permissions, comments, run ids, user ids, reviewer
  email addresses, or RAG chunk bodies.
- `scope: SUMMARY` gives risk, attributions, metrics and severity counts. `FULL` adds individual
  findings, the AI narrative and the retrieved-context file list.
- `redactCode: true` strips source snippets from findings.
- `passphrase` gates access. Supply it in the **`X-Share-Passphrase` header**, never the URL: the
  token has to be in the URL for the link to be shareable, but the passphrase does not, and
  URLs reach access logs and `Referer` headers.
- Unknown, expired and revoked tokens all return an identical 404. Distinguishing them would
  confirm to someone holding a dead URL that it once pointed at something real.
- Revocation sets `revokedAt` rather than deleting the row, so who shared the review and when it
  was cut off survives — that is exactly what an incident review asks about.
- Every successful view is audited with no actor. A forwarded link is otherwise invisible.

Share tokens are redacted from error responses and log lines (`redactSensitivePath` in
`common/all-exceptions.filter.ts`). Without it, every 404 on a dead link would record a live
token at warn level, and logs are read by a wider audience than the database.

### Known limitations

- **Deleting a comment with replies is refused (409).** The schema's self-relation cascades and
  there is no tombstone column, so deleting a thread root would silently destroy other people's
  replies. Adding `Comment.deletedAt` is the real fix.
- **Only static-finding and AI-finding fingerprints are validated.** Both are checked, but a
  fingerprint scheme added later would need adding to `assertFingerprintExists`.

## AI review

The AI review is one stage of eleven, and it is deliberately the most disposable one. It is
declared non-critical in the pipeline, so when it cannot run the review still ships with static
findings, ML risk, retrieved context and the merge gate intact.

### Enabling a provider

Set a key for whichever provider `AI_PROVIDER` names. Nothing else is required:

```bash
AI_PROVIDER=openai          # or anthropic, openrouter
AI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...       # ANTHROPIC_API_KEY / OPENROUTER_API_KEY for the others
```

With no key the process still boots. `validateEnv` emits a `[config]` warning rather than
failing, because an API that refuses to start without an LLM key would make the whole product
hostage to one optional dependency. `GET /health` reports `ai-provider` as `ok: false` with the
reason, and the overall status becomes `degraded`, not `down`.

Per-organization AI settings (`provider`, `model`, `temperature`, `maxOutputTokens`,
`allowExternalModelCalls`, `redactSecretsBeforeSend`) override the environment. `AI_*` is the
deployment default; the org row is the tenant's choice.

`OPENAI_BASE_URL` retargets the OpenAI adapter, which is what makes Azure OpenAI, LiteLLM, vLLM
and a local test double all work without code changes.

### Three gates before any content leaves

1. `allowExternalModelCalls: false` on the organization — refuses outright, no request is made.
2. Secrets detected in the diff and `blockOnSecretDetection` set — refuses, because sending a
   committed credential to a third party makes a bad situation worse.
3. Otherwise, if `redactSecretsBeforeSend` is on, every detected secret is replaced in the diff
   before it is sent, and the review records `redactedBeforeSend`.

### What the model is not trusted with

- **Evidence filtering.** Any finding in SECURITY or DEPENDENCY, or any finding marked CRITICAL,
  must cite a `ToolRun` id that actually executed in this run. Uncited and fabricated citations
  are dropped and counted in `droppedFindingCount`. This is the highest-leverage hallucination
  control in the system, because those categories are exactly the ones a reviewer acts on
  without double-checking.
- **Policy reconciliation.** The model does not get the last word on approval. A surviving
  finding at or above `blockingSeverity`, a detected secret, or a risk score past
  `riskScoreGate` forces `effectiveRecommendation` to REQUEST_CHANGES with `policyOverridden`
  and `policyReasons` set. `modelRecommendation` is kept alongside it so the disagreement is
  visible rather than silently rewritten.
- **Structure.** Every response is parsed and validated against `AiReviewSchema`. A failure gets
  exactly one repair attempt, which shows the model its own output and the validation errors. A
  second failure persists nothing — a partial review is worse than no review, because it looks
  complete.

### When it fails

`aiReviewStatus` on the analysis and workspace payloads carries the outcome, so a client can
tell the three cases apart and offer the right action:

| `state` | Meaning | `retryable` |
| --- | --- | --- |
| `GENERATED` | A review exists | — |
| `SKIPPED` | A gate refused: no key, org opt-out, secrets in the diff | `false` |
| `FAILED` | The provider or the response failed | varies |
| `NOT_RUN` | An upstream stage it depends on did not complete | `true` |

`retryable` distinguishes a transient blip from a configuration problem. A 429, a 5xx or a
timeout says re-run. A rejected key, a missing model, a diff past the context window, or a
response that failed the schema twice says fix something first — re-running just fails again.

Retry behaviour follows the same split. The provider adapter retries 429 and 5xx up to three
times with backoff; it never retries 400/401/403/404. The schema repair is capped at one attempt,
because a model that has failed the same schema twice is not converging and the third call is
pure spend.

### Error text is sanitized

`ToolRun.error` is returned by `/review-runs/:id` and embedded in the review workspace, so it is
effectively tenant-visible. Provider response bodies never reach it: a 400 from OpenAI or
Anthropic routinely quotes the offending input back, which here is the diff and the assembled
prompt. `toProviderError` keeps the status and the provider's machine-readable code
(`invalid_api_key`, `context_length_exceeded`) and discards the body. `classifyAiFailure` then
turns that into a sentence written for a reviewer, keeping the unsanitized cause on `cause` for
server-side logging only.

Shared links carry the narrative — executive summary, technical summary, beginner explanation,
recommendation, rationale, checklist — and none of the machinery: no provider or model name, no
prompt version, no token usage, no cost, no per-finding evidence ids, no tool runs.

## Verification harnesses

Two committed scripts, both idempotent and safe to re-run against seeded data:

```bash
pwsh -File apps/api/test/verify-review-sessions.ps1    # 87 assertions
pwsh -File apps/api/test/verify-ai-review.ps1          # -Section all|disabled|enabled|failures
pnpm --filter @codelens/ai-agent test                  # failure classification units
```

`apps/api/test/fixtures/llm-stub.js` is a **test double, never part of the product**. It speaks
the OpenAI wire format so the real provider adapter, retry logic, JSON extraction, Zod
validation, repair loop, evidence filter and persistence all execute unchanged:

```bash
node apps/api/test/fixtures/llm-stub.js
# then, in the API process:
OPENAI_API_KEY=local-stub-not-a-real-key OPENAI_BASE_URL=http://127.0.0.1:4599/v1 pnpm start
```

It exists because the failure modes that matter most cannot be produced on demand from a real
provider: a rejected key, output that is not JSON, output that is JSON of the wrong shape,
fabricated evidence ids, and a model recommending approval of a change with a CRITICAL finding.
Switch behaviour with `POST /__scenario {"scenario":"..."}`; inspect calls with `GET /__calls`.

It does **not** establish that a real model writes a good review. That needs a real key and a
human reading the output.

## Configuration

Environment is validated at startup by `src/config/env.schema.ts` and the process refuses to
boot on invalid values — a wrong-length `ENCRYPTION_KEY` should fail at boot, not inside an
OAuth callback. Cross-field problems that are survivable are logged as `[config]` warnings
instead, which is how a deployment without an LLM key reports that reviews will skip the AI
stage.

Redis must run with `maxmemory-policy noeviction`. It holds the queues as well as the caches,
and an LRU policy may evict a job hash under memory pressure — the job then disappears with no
error anywhere. Every cache key the API writes carries an explicit TTL, so the cache still
bounds itself. `docker-compose.yml` sets this.

## Layout

```
src/
  analysis/      pipeline driver, report assembly, per-run scratchpad
  auth/          email + GitHub OAuth, JWT, token encryption, RBAC guards
  common/        errors, decorators, Zod pipe, trace id, exception filter
  mcp-tools/     the eleven tools and their IO contracts
  ml/            ML service client with a circuit breaker
  comments/      review discussion threads
  organizations/ members, teams, review policy, AI settings
  queues/        producers, processors, job contracts, /jobs endpoints
  rag/           indexing and hybrid retrieval
  review-sessions/ workspace assembly, verdicts, merge gate, share links
  worker.ts      dedicated worker entrypoint
```

`QueuesModule` (producers) and `WorkersModule` (consumers) are separate on purpose. Producers
must be injectable anywhere, while consumers depend on the services those same modules
provide; merging them creates a cycle that `forwardRef` can hide but not fix.
