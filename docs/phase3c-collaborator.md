# Phase 3C: Evidence-Grounded Collaboration

## Scope and Status

Implemented against `c54ba797bc34b441e4a7e638a26f613631d46dd7`.
Local deterministic verification completed on 2026-10-03. This is an uncommitted
implementation report, not exact-revision release certification or hosted CI.
The deterministic pass made no real provider request. A subsequent separately
approved bounded Gemini attempt is described below; it did not complete successfully.
No GitHub mutation occurred. Original/C2 resources were not modified. Phase 3D,
patches, shell execution and `search_symbols` remain absent.

## Persistence and Execution

The additive `20261003000000_collaborator_execution` migration retains `RECORDED`
turns, adds executable turn states and assistant messages, adds structured citation
and provider/model fields, and creates tenant-bound `CollaborationAttempt` records.
Compound foreign keys bind attempts to the same organization/PR/turn. A unique
`(turnId, kind)` index prevents duplicate human/assistant messages for a turn.
Existing migrations are unchanged. API startup verifies readiness; it performs no DDL.

Human submission persists first, reserves an attempt, then enqueues a deterministic
BullMQ job. The normal path is `QUEUED -> RUNNING -> COMPLETED`; alternatives are
`FAILED`, `CANCELLED`, or `INTERRUPTED`. Old `RECORDED` turns are not automatically
sent to a provider. Explicit retry creates a new fenced attempt on the same human
turn, retaining earlier attempts and not duplicating the conversation question.

Jobs use `collaborate-{turnId}-{attempt}`, are retained, and have one BullMQ attempt.
Replay does not re-execute a running/completed attempt. Expired running leases are
marked interrupted with uncertain outcome on read/replay/retry, not automatically
replayed as potentially paid requests. Queue outage preserves the human question:
the same request UUID can re-enqueue a queued attempt. Database/Redis enqueue is
not a distributed transaction or transactional outbox.

Cancellation changes persisted state and rotates fences. Worker polling checks
state/fence every 200 ms and propagates AbortSignal to provider/tool transports.
Reservations, evidence finalization and assistant persistence revalidate fences.
Final persistence also checks the deadline immediately before and after its writes;
crossing that check rolls back the transaction. Transport abort is best-effort:
remote computation/billing may continue, but late application writes are rejected.
The 90-second execution budget does not promise database/network recovery within
90 seconds or a hard upper bound on PostgreSQL transaction commit latency.

## Protocol and Budgets

Only strict `RESPOND` and `REQUEST_TOOLS` JSON actions are accepted. Respond includes
content, structured evidence IDs/claims, observed/inferred strengths and an
evidence-based/unknown certainty decision. Unknowns are expressed in answer prose;
the certainty discriminator is validated but is not a separately persisted UI field.
No reasoning field, patch action or authoritative model-supplied scope is accepted.
Every tool input is validated again against its existing Phase 3B schema.

| Bound                        | Enforcement                                                          |
| ---------------------------- | -------------------------------------------------------------------- |
| Previous messages            | At most 8, bounded excerpts, conversational context not facts        |
| Assembled context            | 12,000 UTF-8 bytes including system policy; conservative token proxy |
| Provider rounds              | 4 per logical human turn across attempts                             |
| Transport requests           | 5 including retry and repair across attempts                         |
| Tools                        | 8 per logical turn, including prior/manual/failed tool reservations  |
| Independent tool concurrency | 2                                                                    |
| Provider output              | 2,000 requested tokens and at most 2,000 returned JSON UTF-8 bytes   |
| Total output                 | 8,000 conservative units across attempts                             |
| Wall-clock execution         | 90 seconds from worker claim, per execution attempt                  |
| Structured repair            | At most 1 per attempt, within total request budget                   |

Requests reserve maximum output before transport and checkpoint counters before
calling the provider. Failed/uncertain requests retain that reservation. Successful
outputs use the larger of UTF-8 bytes and reported completion tokens. This is not
exact token metering or actual billing. Large legitimate questions/answers can be
rejected by these stricter bounds. Adapter retries are explicitly set to one;
typed transient retries occur in the bounded engine without provider switching.
Explicit retry cannot reset logical-turn request/round/output/tool ceilings.

## Context, Evidence and Trust

Context is a separate system policy plus an `UNTRUSTED_DATA` JSON envelope containing
the current redacted question, bounded recent history, authoritative pinned scope,
anchor and selected persisted evidence. Tool observations append redacted, bounded
excerpts with their provenance, revision and coverage retained. Analysis/ML/report
evidence is obtained on demand through the existing analysis-evidence tool, rather
than dumping all analysis records into every prompt. Indexed context is not upgraded
to exact revision; previous assistant assertions are not repository facts.

The nine existing Phase 3B read tools are reused without a second implementation:
PR diff, changed files, file range, repository search, indexed context, analysis
evidence, review thread, tests and repository metadata. Server-side membership,
tenant/PR scope, pinned revision, input validation, budgets and fencing remain
authoritative despite source/README/comment injection text.

Citation IDs must be unique and available in the assembled current-turn context.
Before persistence, the database rechecks same tenant/turn, permitted source type,
successful/partial/limited tool state and evidence existence. Fabricated IDs are
repaired once or fail without a partial assistant. This is mechanical validation,
not semantic entailment or a guarantee against misleading model reasoning.

Provider resolution uses organization policy and the existing provider abstraction,
with no collaboration-specific Gemini coupling, silent fallback or production stub.
Missing credentials/disabled external calls fail truthfully while preserving the
human message. No credentials are passed to investigation tools. Safe audits record
IDs, statuses, counts and durations, not prompts, messages or source excerpts.

## API and Frontend

`POST /conversations/:id/messages` now returns 202 after persistent enqueue.
`GET /collaboration-turns/:id` reads state/accounting;
`POST /collaboration-turns/:id/cancel` cancels;
`POST /collaboration-turns/:id/retry` accepts the expected attempt generation.
Existing authentication and developer role guards remain in effect. Foreign tenant
reads, polling, cancellation, retry, jobs, tool calls and evidence return not found.
Cancellation/retry are owned by the initiating actor.

The existing panel shows human/assistant messages, persisted state/tool activity,
cancel/retry controls and structured observed/inferred citations opening the existing
EvidenceViewer. Follow-ups remain in the conversation; reload retains readback.
Head movement labels historical evidence rather than changing its stored revision.
There is no chain-of-thought or patch UI and no workspace redesign.

## Verification

- Prisma validation/generation passed.
- Workspace tests: **317 passed** (shared 1, AI 77, database 14, static 11,
  GitHub 13, RAG 29, API 172). These include 50 collaborator-engine and 23
  execution-service cases, plus provider, tool-fence, queue and migration regressions.
- Sequential workspace typecheck passed. Package and production API/worker/web
  builds passed; runtime proof used the final built images below.
- Focused browser proof: 13 normal-path checks and 3 historical-head checks passed;
  the latter also passed after restart. No unhandled browser exceptions; tested
  390px layout had no document overflow. Installed Chrome was selected explicitly
  because bundled Playwright Chromium was unavailable.
- Existing walkthrough: **81 passed / 2 failed**, reproducing unchanged
  `91 / CRITICAL` assertions against seeded `78 / HIGH`. Two expected sign-in 401
  diagnostics remain disclosed. This run reported no layout detections; older
  clipping observations are not reclassified as universally fixed.
- Canonical tracked-content Prettier comparison: **143 before / 143 after**,
  no new failures. Existing debt was not mass-formatted. No Python changes;
  previously disclosed Ruff debt remains unchanged, not claimed clean.
- `git diff --check` passed. No hosted CI for this uncommitted diff is claimed.

### Isolated Runtime

Project: `codelens_phase3c_20261003`. Web/API loopback ports: 53403/54403.
New volumes: project-prefixed `postgres_data`, `managed_postgres_data`, `redis_data`.
Separate PostgreSQL services provided fresh initialization and managed 3B upgrade.

Final API/worker image manifest:
`sha256:5785020a0fea3b0dddedc2f91ac3780b0afb76f7fc0da674232a080e2c4a056d`.
Final web image manifest:
`sha256:878b1ee013184601f0f5f901baf5855fde0c719cb9a0d713aa7d6510d372d9d9`.

Fresh initialization applied all four migrations and left all 35 application tables
empty before explicit documented demo initialization. Managed upgrade applied only
3C; existing 3B conversation, human message, tool call and evidence survived.
The upgrade harness compared 34 legacy-table hashes while excluding added message/
attempt fields; its original normalization also omitted `provider`/`model` keys on
other tables, so that comparison is not claimed as a full byte-for-byte database
proof. A subsequent focused comparison verified all five collaboration-table hashes
against their original 3B values with only newly added columns excluded. Direct
sentinel checks and the separate full-row restart proof supplement this evidence.

Final-image proof used real PostgreSQL, Redis, BullMQ and worker execution, with an
explicit mounted deterministic provider/read-only GitHub fixture. The mount is not
present in production images and has no production feature flag or registry entry.
RAG-unavailable behavior was injected at the tool boundary, not a real RAG network
outage. Real Phase 3B reservation, authorization, evidence and persistence paths ran.

With the worker stopped, a persisted human question queued exactly one job; replay
kept the same message/attempt. Starting the worker executed two real investigation
tools and two provider rounds, persisted one assistant with a resolvable exact-head
file citation, then completed an ordered follow-up. Fabricated citation repair used
three requests and one repair. Forbidden shell requests failed without tools or an
assistant. Provider unavailable preserved the question and failed truthfully.
Direct file evidence remained usable alongside persisted RAG `UNAVAILABLE`.
A delayed provider deliberately ignoring abort could not persist after cancellation;
explicit retry used a new attempt and produced one assistant. Foreign tenant checks
failed closed for conversation/turn/job/tool/evidence and cancellation/retry.

Before the regression walkthrough's intentional comment/verdict/share operations,
hashes of Comment, Review, ReviewRun, PrMetrics, MlPrediction, AiReview, StaticFinding
and RagChunk remained unchanged by collaboration execution. Full-row hashes of all
35 application tables, including attempts, survived normal isolated restart.
Repeat db-init reported managed state, four migrations and no pending migration.
Historical exact evidence remained browser-resolvable after restart.
Seven supplied diagnostic markers (source/question and synthetic local secrets) had
zero hits in checked API/worker/web logs. This is scoped evidence, not universal
secret non-leakage or penetration testing. No real credentials were used.

### Adversarial Corrections

Review fixed human replay selecting an assistant, explicit retry resetting logical
provider budgets, an optional queue dependency masking missing production wiring,
and final persistence crossing the deadline without rollback. Tests cover these
corrections. Tool execution is fenced both at reservation and finalization, and
manual reads cannot compete with an active AI attempt's tool/concurrency budget.

### Remaining Boundaries

Real collaboration-provider behavior and semantic answer/retrieval quality are
unverified. Crash/interruption and deadline cases are automated-test proven, not
host-level SIGKILL or real-provider timeout runtime proof. No exactly-once external
side effects/billing, immediate stalled recovery, universal injection prevention,
exhaustive accessibility or infrastructure-log safety is claimed.
Cancellation cannot guarantee remote compute/billing stops. Database operations are
not transport-abortable. Provider/round/output budgets persist across explicit retry;
the 90-second execution clock starts anew for each explicit attempt.

Deterministic Phase 3C exit criteria are satisfied; this does not certify a future
commit or implement Phase 3D. Successful real collaboration remains unverified.

## Separately Approved Bounded Gemini Attempt

This verification reused an existing locally configured Gemini key without printing
it, placing only the required key/Google-compatible base URL in an ignored Phase 3C
environment file. A single authenticated read-only model-list request confirmed
`gemini-3.8-flash` was listed for generation. The existing provider abstraction used
Google's compatible endpoint and truthfully persisted provider `GEMINI`; no OpenAI
request or production provider-specific collaboration behavior was introduced.

Only the existing isolated Phase 3C project was reconfigured. Seeded PR #412 retained
its four files and +26/-5 metrics. A read-only mounted upstream fixture returned its
stored head and synthetic file snapshots reconstructed from the seed's imported
diff; omitted source lines were explicitly fixture padding. A synthetic README
carried the injection text. This did not prove real upstream GitHub exact reads.
No synthetic provider was installed in this real-provider configuration.

Conversation: `cmuryvfpb0007sc016djgqtty`.
Turn: `cmuryvfri000bsc0153qeaytb`.
Pinned head: `f1e2d3c4b5a6978877665544332211aabbccddee`.
Question: "Why is this refund change considered risky? Use repository evidence and
distinguish what is directly observed from what is inferred."

| Request | Observed result                                                                            |
| ------- | ------------------------------------------------------------------------------------------ |
| 1       | HTTP 503, no completion                                                                    |
| 2       | HTTP 200, model `gemini-3.8-flash`, `finish_reason=tool_calls`, null/empty message content |
| 3       | HTTP 503, no completion                                                                    |
| 4       | HTTP 503, no completion                                                                    |

The second response did not provide a valid JSON collaborator action in normal
message content. Native tool-call presence/arguments were not retained and remain
unproven. No native tools were declared or executed. One repair and three
retryable-failure counter increments were recorded; only two transient retry requests
actually occurred. The next output
reservation would exceed the logical turn's conservative output budget, so the
turn ended `FAILED / PROVIDER_BUDGET` without a fifth request.

Persisted counters: 4 provider requests, `providerRetries=3`, 1 repair, 1 round, 0 tools,
0 evidence/citations, 4,664 context bytes and 6,008 conservative reserved output
units; duration 37,876 ms. Reserved units are not actual generated/billed tokens:
failed requests retain reservations. The human question remained persisted, and
there was no assistant message. Audit bodies/source dumps were absent. The real
provider request envelope retained authoritative server scope and untrusted data
separation, but repository injection evidence was never reached.

Further paid calls stopped. A successful first answer, same-conversation follow-up,
real-provider tool/evidence/citation path and real-provider injection exercise are
**NOT PROVEN**. Listing a model did not establish runtime availability or compatible
structured output. These observations establish HTTP availability failures and
missing JSON-content actions, not native tool-request validity or an adapter defect.
No production correction or model-specific workaround was made.

The existing production action validator rejected a fabricated evidence ID against
this turn's empty available-evidence set; no assistant was written. This was a local
boundary check, not proof that real Gemini fabricated a citation or repaired one.
Earlier deterministic citation-repair/provenance/degradation evidence remains scoped
and unchanged.

Browser/API/database readback verified preserved human text, truthful failure,
reload persistence, visible retry control (not invoked), no fabricated citation/
assistant, no patch controls and no unhandled browser exception. Safe transport
observations store counts/status/model metadata, not prompts or raw reasoning.
Supplied key matching found zero hits in checked isolated API/worker/web logs, all
38 proposed files and the checked generated proof outputs. Key/Bearer patterns were
also absent from those logs; this is not a universal leak guarantee.

Targeted deterministic rechecks passed: 59 AI tests and 25 execution/provider API
tests. These are subsets of the previously reported 317, not additional coverage.
Runtime wiring was restored to credential-free deterministic configuration after
readback; ignored Gemini environment/override/proof files remain excluded. No
commit, push, GitHub mutation, real embedding or additional analysis job occurred.
The requested successful real-Gemini verification remains incomplete and should not
be represented as commit/release certification.

### Tool-Call Diagnostic: D / Not Proven

No additional real request was made. The HTTP 200 record retains status, model,
`finish_reason=tool_calls`, zero normal-content bytes and usage (1,243 prompt / 8
completion / 1,317 total). It omits native tool-call presence/count/names/arguments,
legacy `function_call`, and whether content was absent, null or empty. A finish
reason cannot recover those fields. Classification is **D: NOT PROVEN**, not A/B/C.

The production path is Google-compatible HTTP -> OpenAiProvider ->
`LlmCompletion.content` -> collaborator JSON parse/Zod -> bounded repair -> reserved
request/output accounting. The adapter reads content, usage, model and finish reason;
it does not normalize or validate native calls. Requests supply JSON response format
but no native `tools`, `functions` or `tool_choice`. Canonical collaboration remains
strict JSON-in-content `RESPOND`/`REQUEST_TOOLS`, with existing server-side 3B input
validation. No second execution path was added. Existing analysis also validates
`completion.content`; its registry/DAG is not provider-native function calling.
Prior successful Gemini analysis does not prove native tool support.

| Request | Cause                                                                | Output reservation after settlement |
| ------- | -------------------------------------------------------------------- | ----------------------------------- |
| 1       | Initial request, HTTP 503                                            | 2,000 retained                      |
| 2       | Transient retry, HTTP 200 with empty content and 8 completion tokens | 2,008                               |
| 3       | Structured-output repair, HTTP 503                                   | 4,008                               |
| 4       | Transient retry, HTTP 503                                            | 6,008                               |

A fifth reservation would require 8,008 > 8,000, so `PROVIDER_BUDGET` accurately
describes the terminal reason even though four requests are below the five-request
ceiling. Each transport counts once; repair counts toward requests. Failed requests
retain conservative output reservations, not assumed zero cost. The HTTP 200
reservation reconciles once to max(0 content bytes, 8 completion tokens).

**Accounting diagnostic concern:** `providerRetries` increments on retryable error,
before checking whether the next reservation is allowed. Thus three here means
three retryable failures/intentions, not three executed retry requests. Only two
transient retry requests and one repair actually ran. The last retry intent never
reached transport. Budget enforcement is correct, but the name/earlier wording
overstates executed retries. Resolve that semantics issue explicitly before making
a retry-count claim. Production accounting was not changed in this diagnostic-only
pass, and budgets were not loosened.

Two deterministic diagnostic tests were added in existing inventory files: a
**hypothetical** populated native-call response demonstrates the adapter's content-only
contract and absence of request tool declarations; replay of retained results
reconciles four requests, repair, current retry-counter semantics, 6,008 units and
zero executed tools. The hypothetical payload is not recovered real-response data.
Targeted runs passed **61 AI / 110 API** tests, AI package typecheck and diff checks.
These are not a new full-workspace count; the prior 317-test full run is historical.

One separately approved **single-network-request diagnostic retry** is justified to
capture missing structure, not prove successful collaboration. Proposed scenario:
same isolated PR #412/model/question, new human turn (the original cannot reserve
another 2,000 units), ordinary adapter with no native declarations, test-harness
transport ceiling of one HTTP POST and no subsequent paid retries/repairs or model
switch. Capture only native field presence/count/type, known allowlisted names,
argument byte sizes and JSON/schema-validity booleans, content presence/type/length,
finish reason, status and usage. Do not retain raw arguments, prompts, reasoning,
credentials or raw native IDs. Never execute a native payload directly. Block any
second transport locally. If the single request returns 503, stop. This scenario
has not been enabled or run; separate approval is required.

### Separately Approved Single-POST Response-Shape Diagnostic

Exactly one subsequent Gemini POST was separately approved and executed. This was
not a normal collaboration-success test. The ordinary API persisted a new PR #412
question; with the worker stopped its queue reservation was cancelled to prevent
normal execution. A local/ignored standalone driver used the actual context assembler
and existing provider adapter, with adapter retries set to one and a persistent
one-POST guard. It did not run the collaboration loop, repair, tools or fallback.

Result: **A / NORMAL JSON-IN-CONTENT RESPONSE**. HTTP 200, `gemini-3.8-flash`,
`finish_reason=stop`, message object present, normal content present as a non-empty
122-byte string. The content validated as `VALID_REQUEST_TOOLS`, including Phase 3B
tool-name/input validation. Raw content and arguments were not retained.
Native `tool_calls` and legacy `function_call` fields were absent. Other message keys
were `extra_content` and `role`; their values were not included in the diagnostic.
Usage: 1,243 prompt tokens, 35 completion tokens, 1,319 total tokens. No hidden
reasoning was captured or persisted; the usage counts are reported as supplied.

The request used Google's compatible chat-completions endpoint, model
`gemini-3.8-flash`, JSON object response format, two messages, 4,554 context bytes,
5,240 body bytes and max output tokens 2,000. It advertised no `tools`, `functions`,
`tool_choice` or `function_call`. No provider-native execution support was added.
This demonstrates that the existing JSON-content protocol can receive a valid action
from the real provider, but not that an entire turn, tool execution, grounded answer
or follow-up succeeds. The previous anomaly did not reproduce; its missing fields
remain unknown and are not retrospectively classified as valid native calls.

The human turn remained cancelled with zero normal worker provider requests and no
assistant/tools/evidence. The one external request is recorded only in the local
structural diagnostic, not represented as a normal worker attempt. Production tables
contain no raw provider response or prompt dump. Supplied credential matching found
zero hits in checked structural outputs, isolated logs and 38 proposed files.
The approved local credential file remains ignored. API/worker wiring was restored
to credential-free deterministic configuration; no original/C2 resource or GitHub
state was modified. Diagnostic files remain ignored/excluded; production parsing and
retry-counter behavior were unchanged. The separately approved normal bounded
collaboration execution is recorded below. No commit/push or Phase 3D work.

## Final Bounded Real Gemini Collaboration Attempt

The approved normal production path ran on 2026-10-03 in
`codelens_phase3c_20261003`, using `gemini-3.8-flash`, seeded/synthetic PR #412
and a fresh conversation `cmus0e21o0003o801mkc80cqs`.
The exact approved first question persisted in turn `cmus0e24e0007o801gx7jgb27`.
HTTP 202 returned `QUEUED` while the worker was stopped; the isolated worker then
consumed the job through normal BullMQ execution. Only read-only synthetic GitHub
access was replaced. Provider selection, JSON-content parsing, validated tool
requests, Phase 3B execution and persistence were production paths. No manual
tools, injected responses, native tool execution or budget changes were used.

Five real requests returned HTTP **200, 503, 200, 503, 200**. All three successful
responses led to validated `REQUEST_TOOLS`; none produced `RESPOND`. The turn
ended truthfully at **FAILED / PROVIDER_BUDGET** after 58,533 ms. No assistant or
citation persisted. The follow-up was not submitted, and no standalone paid
injection turn or extra diagnostic request was made. Provider availability and
tool-selection variance consumed the budget; no production defect was established.

Five tools completed: `list_changed_files` (PARTIAL), `read_pr_diff` (PARTIAL),
`read_analysis_evidence` (SUCCESS), `read_pr_diff` (PARTIAL, remaining page), and
`read_analysis_evidence` (SUCCESS, static findings). Thirteen evidence references
persisted: four CHANGED_FILE and four PR_DIFF references with SNAPSHOT provenance,
one REPORT_SNAPSHOT and four STATIC_FINDING references with DERIVED provenance.
No evidence was promoted to independently verified current source. This remains
synthetic-fixture verification, not a new real GitHub proof.

Transport metadata proves selected persisted evidence returned to subsequent
Gemini contexts: evidence counts **0, 6, 6, 6, 6**, with context sizes
**4,554 / 11,366 / 11,366 / 11,760 / 11,760 bytes**. All IDs matched the authorized
turn's persisted evidence. The final four static references were produced after
the fifth request and did not reach another provider request. Historical-message
count was zero for this fresh conversation. No naturally encountered injection
evidence or native tool-call anomaly was observed; deterministic adversarial tests
remain the enforcement evidence, not a universal model-resistance claim.

Accounting: five provider requests, two observed retryable failures, two actual
transient retry requests, zero repairs, three rounds, five tools, and **4,382**
output units. The total reconciles three successful content-byte charges
**174 + 110 + 98** and two uncertain failed-request reservations **2,000 + 2,000**.
Provider duration was 57,586 ms; recorded tool-batch duration was 508 ms.
Existing limits were unchanged. `providerRetries` still denotes retryable failures
observed, not a general count of executed retries (the counts coincide in this run).

Database/readback checks passed across conversation, human message, terminal turn,
single terminal attempt, five terminal tool calls, thirteen evidence records and
audit lifecycle. Tenant/PR/repository ownership and pinned SHA matched; audits held
safe lifecycle metadata rather than full prompt/message/source dumps. The activity
list deliberately omits evidence bodies; all thirteen individual evidence API
endpoints were separately checked. No duplicate/fabricated assistant or RUNNING
attempt/tool remained. Browser login/readback/reload preserved the human question
and truthful failure, exposed retry without invoking it, and fabricated no answer,
citations or patch controls. Successful-answer/citation UI and multi-turn readback
were not exercised by this failed attempt.

Checked database records, isolated API/worker/web logs, proof artifacts and proposed
files contained zero supplied credential-value matches. Observed concurrent tool
execution peaked at two. Both API and worker were restored and
checked for absent Gemini credential/endpoint. No original/C2 resources, GitHub
state, old migration or production source changed during this proof. Local drivers
and structural-only diagnostics remain ignored/excluded. Relevant deterministic
regressions passed: AI collaborator 51 + provider 10; API conversation 35 +
investigation 16 + tools 34 + execution 23 + provider 2 (**171 total**).

**FULL REAL-PROVIDER PASS: NOT ACHIEVED. MULTI-TURN PASS: NOT ATTEMPTED.**
The tool/persistence/context portion is now real-provider runtime-proven, but
successful grounded response, real citations and follow-up remain unverified.
The user accepted these documented limitations for committing Phase 3C; this does
not upgrade the real-provider evidence or represent a full real-provider pass.

Accepted verification status:

- Phase 3C deterministic verification: **PASSED**
- Real Gemini investigation/tool/evidence path: **PARTIALLY VERIFIED**
- Real Gemini final grounded response/citation path: **NOT VERIFIED**
- Real Gemini multi-turn collaboration: **NOT VERIFIED**

Successful final Gemini RESPOND, real-provider final citation persistence,
real-provider semantic answer quality, real-provider multi-turn follow-up and a
full real-provider pass remain explicitly unverified.

## Proposed Commit Inventory (38 Files)

```text
apps/api/src/collaboration/collaboration.controller.ts
apps/api/src/collaboration/collaboration.module.ts
apps/api/src/collaboration/collaboration.service.test.ts
apps/api/src/collaboration/collaboration.service.ts
apps/api/src/collaboration/investigation.service.test.ts
apps/api/src/collaboration/investigation.service.ts
apps/api/src/collaboration/collaboration-execution.service.test.ts
apps/api/src/collaboration/collaboration-execution.service.ts
apps/api/src/collaboration/collaboration-provider.service.test.ts
apps/api/src/collaboration/collaboration-provider.service.ts
apps/api/src/queues/application-shutdown.ts
apps/api/src/queues/queue.service.test.ts
apps/api/src/queues/queue.service.ts
apps/api/src/queues/queue.types.ts
apps/api/src/queues/workers.module.ts
apps/api/src/queues/processors/collaboration.processor.ts
apps/web/src/components/workspace/conversation-panel.tsx
apps/web/src/components/workspace/evidence-viewer.tsx
apps/web/src/lib/api.ts
apps/web/test/investigation-foundation.mjs
apps/web/test/collaborator-foundation.mjs
packages/ai-agent/src/index.ts
packages/ai-agent/src/providers.test.ts
packages/ai-agent/src/providers.ts
packages/ai-agent/src/collaborator.test.ts
packages/ai-agent/src/collaborator.ts
packages/database/package.json
packages/database/prisma/schema.prisma
packages/database/prisma/migrations/20261003000000_collaborator_execution/migration.sql
packages/database/src/client.ts
packages/database/test/collaborator-migration.test.ts
packages/shared/src/constants.ts
packages/shared/src/contracts/ai-review.ts
packages/shared/src/contracts/conversation.ts
packages/shared/src/contracts/index.ts
packages/shared/src/contracts/collaborator.ts
docs/phase3c-collaborator.md
docs/verification.md
```

Local `.compose.phase3c.local.yml`, `.codelens-tmp/phase3c/` drivers/results and browser
screenshots remain ignored and excluded from the commit inventory. Existing Docker
exclusions omit local environment/Compose files, proof mounts and browser drivers.

Suggested commit: `feat(collaboration): add bounded evidence-grounded AI turns`.
No commit or push has been made.
