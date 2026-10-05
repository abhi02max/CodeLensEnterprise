# Phase 3G: Human Decision Loop

## Freeze Scope

Starting and final HEAD: `7893a3c4e08b0ab743ca418b4f6ab1840d898f8c`.
This is uncommitted local evidence, not exact-SHA hosted-CI certification.

Phase 3G deterministic exit criteria: PASSED for the scoped workflow and
boundaries below, subject to the disclosed pre-existing walkthrough/tooling debt.
Ready for human freeze review; not committed or deployment-certified.

Scope B closes displayed-head verdict binding and atomic final Review/audit
persistence. It uses the existing Phase 3 domains without changing schema,
migrations, models, provider budgets, sandbox policy or GitHub capabilities.
The separately approved correction makes empty ML-assessment and AI re-review
GET histories explicit JSON `null`, rather than an empty HTTP 200 body.

## Verdict Semantics

`expectedHeadSha` is required and validated as a full lowercase 40-character
Git SHA. The browser uses the existing review-session head; it supplies no
independent revision authority. The service validates again, locks the
tenant-scoped PullRequest row with `FOR UPDATE`, reads its authoritative head,
and compares before writing. A mismatch returns HTTP 409 / `CONFLICT` with
`reason: HEAD_CHANGED`, without Review, critical audit or feedback mutation.

The existing role, tenant, merged-PR and self-approval checks remain enforced.
REVIEWER or higher can submit a final verdict; DEVELOPER cannot. The author
cannot approve their own PR. A foreign PR remains a scoped 404.

Review upsert and `review.submitted` audit creation share one Prisma transaction.
The transaction-aware audit helper retains safe metadata projection and throws
write failures. Ordinary noncritical audit calls retain best-effort handling.
Training feedback runs after commit and remains best-effort: its failure does
not roll back the verdict or audit. No database transaction spans provider or
GitHub network reads.

Same reviewer/head still updates one Review row. Each successful submission has
its corresponding audit event; identical submissions are not request-ID
exactly-once operations. Concurrent differing decisions serialize. PR head
updates either precede the locked verdict and cause rejection, or wait until
the verdict transaction commits against the expected old head.

The UI distinguishes the PR verdict from isolated candidate acceptance and
validation. On stale conflict it requires explicit refresh, clears the old
draft, holds verdict controls disabled through refetch, and never resubmits.
If refetch fails, the existing workspace-level load error removes decision
controls; explicit human reload is required. No automatic verdict is submitted.

## Isolated Runtime

Project: `codelens_phase3g_human_loop_20261005`.

- Web: `http://localhost:53410`, bound to loopback.
- API: `http://localhost:55410/api/v1`, bound to loopback.
- Containers: project-prefixed postgres, redis, ml-service, api, worker, web,
  provider, material-broker and validation-broker.
- New volumes: project-prefixed postgres_data, redis_data, material_control,
  material_journal, validation_control and validation_journal.
- Application database: `human_loop`; separate fresh-deploy proof database:
  `human_loop_fresh`, both on the new isolated PostgreSQL volume.
- Earlier proof API/worker image configuration ID (not the resumed canonical image):
  `sha256:838da39c4121c700fe07e0bfe2a023f0ec35535cddb0b1201c4610f8f745ff71`.
- Earlier proof web image configuration ID (not the resumed canonical image):
  `sha256:2e047d0477c9790e73d0c9d9fa8480d2a0524ca43461ec46db0c8dca74413977`.

The existing 116 containers and 63 volumes retained their IDs/names. No previous
proof project or original CodeLens resource was modified. Only the brokers have
Docker socket authority. API/worker use the existing restricted broker clients.
Existing executor images were reused by immutable ID in new containers, without
altering earlier image tags or policy.

### Provisioning Disclosure

The first provisioning command incorrectly used root `db:migrate`, which invokes
`prisma migrate dev`. It applied the 11 existing migrations to the new empty
`human_loop` database and then prompted for a new migration name. The isolated
tool container was stopped without answering; no migration was generated, no
reset/data-loss flag was used, and no existing database was touched.

To establish the correct clean lifecycle independently, a second empty database,
`human_loop_fresh`, was created on the same new isolated PostgreSQL instance.
The documented container initializer reported `Database state: empty`, used
`prisma migrate deploy`, applied all 11 checked-in migrations, and verified RAG
infrastructure. Both isolated databases were verified to contain zero application
rows before explicit demo initialization. `human_loop` subsequently reported
`managed`, no pending migrations, and RAG readiness. Runtime preload was disabled
for the TypeScript initializer to avoid a test-preload/loader conflict.

## Canonical Human Scenario

The reviewer visibly signed in, navigated through repositories and PRs, and
inspected the original finding at `src/value.ts:2` on controlled PR #447.
Its original completed analysis was explicitly preloaded fixture data, not a
newly executed original live analysis. The finding concerns `eval(input)`.

Explicit human actions: create conversation, send investigation request, inspect
canonical diff and exact evidence, accept proposal, request isolated application,
request paired validation, request ML comparison, request bounded AI re-review,
follow a citation, submit REQUEST_CHANGES, reload, and explicitly refresh a stale
review. Tested actions also used keyboard focus/Enter. No candidate stage submits
a verdict automatically; existing reviews remained byte-identical until the
explicit human verdict action on the final-image repeat.

Automatic transitions: real BullMQ consumes each explicitly requested stage;
the deterministic collaborator requests the real exact-source tool, receives
persisted evidence, and returns PROPOSE_PATCH; existing servers validate and
persist immutable proposal data; real restricted brokers materialize and validate
the candidate; static analysis, local Python ML and sealed AI evidence readback
complete their existing bounded workflows.

The candidate replaces eval with treating input as data. Original and patched
TypeScript checks pass; the original unit test fails and the patched test passes.
Static comparison records one RESOLVED occurrence and no introduced occurrence.
Local ML reports ORIGINAL 84.3/HIGH, PATCHED 79.5/HIGH, delta -4.8, unchanged band.
These are advisory model observations, not accuracy or safety certification.
The deterministic AI assessment is INCONCLUSIVE and cites persisted sealed
evidence. Its summary explicitly says the actual PR is unchanged.

The human records CHANGES_REQUESTED because the candidate was only materialized
and compared in isolation. No PR branch was updated. Final Review identifies
PR + reviewer + head, not a candidate foreign key; candidate provenance remains
connected through the workspace's existing Phase 3 lineage.

## Earlier Successful Lineage (Retained)

Additional persisted static identifiers: ORIGINAL analysis
`019ad218-0048-4a3e-9a9c-8a662b8f1d3e`, PATCHED analysis
`502eda87-2646-4a35-8072-dd8c73439c38`, resolved finding
`deffe518-ab96-4360-a8b8-dfc6d3930f73`. AI attempt:
`551a41dc-d002-469c-bf1b-507b18a0e2ec`. Its 15 sealed evidence references
were persisted/read back; the cited summary reference is
`9fba12c0f5e6ea4fbb4f2324fbb33500a48f3e40f8eb997578a991dcead10692`.
The ignored scoped readback report inventories every evidence ID and audit action.

| Object                           | Identifier                             |
| -------------------------------- | -------------------------------------- |
| Organization                     | `cmuvay3gy0000kx0z39lfkax5`            |
| Repository                       | `cmuvay3l3000nkx0zo927wpvb`            |
| PR #447                          | `cmuvaysr50001k5019rqx50uv`            |
| Original ReviewRun               | `cmuvb0tki0003s101q8bdo2nx`            |
| Original finding                 | `cmuvb0tkn0007s10197amdtim`            |
| Conversation                     | `cmuvcn5660003pd01kjqlw0lv`            |
| Turn                             | `cmuvcn5d80007pd010oen72o0`            |
| Collaboration attempt            | `cmuvcn5e5000dpd01kbv5ov6a`            |
| Tool call                        | `cmuvcn5mi0003o001w167a07b`            |
| Exact EvidenceReference          | `cmuvcn5n30007o001259ke4vw`            |
| Proposal, revision 1, ACCEPTED   | `cmuvcn5pa000bo001fqcdosqa`            |
| Application, APPLIED / DISPOSED  | `4a30ab87-9ed7-49e0-85af-3781c00a59d3` |
| Application attempt              | `73f715fe-0fc3-45bf-b88a-1ec3f7058e48` |
| Validation, COMPLETED / DISPOSED | `53b0ab85-27a5-4651-a572-35a9d612db49` |
| Original TypeScript step, PASS   | `b2054a9b-90c5-474f-afcc-99196f6118a2` |
| Patched TypeScript step, PASS    | `55a2d041-11b0-4846-af5c-34463867c0a0` |
| Original unit-test step, FAIL    | `bbb69c3b-27ca-48ba-83cf-cbb562699905` |
| Patched unit-test step, PASS     | `add611da-79cb-4d53-90e0-30bc4fad0385` |
| ML comparison                    | `bfc59aac-9f53-4403-b653-b91e77fb96bb` |
| Original ML assessment           | `bea7e983-f1b7-4fe6-b61d-28ce4681eaec` |
| Patched ML assessment            | `a8e86f51-18ca-4eec-b190-3bc2ec1d961d` |
| AI re-review                     | `e0169233-466b-453a-b6eb-fe4d696fd0f4` |
| Final Review                     | `cmuvc4dbl002bn9019qbe4oe1`            |
| Final-image verdict audit        | `cmuvco60k000vpd016zerws2u`            |

Head: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.
Base: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`.
Both are intentionally controlled transport identities, not external GitHub SHAs.

- Proposal digest: `53e2202909dd7ad226f791595537a7ef65f049496d920f5b3528b2149f2f0cf4`.
- Snapshot digest: `7aaf256926d676f44ffbe6136f13f381412a0d9584b01743a723adae42661d4d`.
- Candidate/materialization manifest digest:
  `20f2164e1987e28495832eee3479cddcd45e89454d585cc4c5e6b7f60619b7a9`.
- AI packet digest: `5b25270a861b5ac804e9402cd843641f4137a5cca3c4d696eebbe7fc15895f8f`.

DB/API readback asserts tenant/PR scope, head/base pins where present, proposal
digest, snapshot lineage, candidate digest and resolvable AI citations. Application
snapshot/manifest digests belong to its attempt, not its top-level row. Two
successful browser runs updated the same reviewer/head Review and produced two
critical events, consistent with existing upsert semantics.

## Boundary Evidence

| Boundary               | Observed proof                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale head             | Browser H1, authoritative H2, POST H1 returns 409; Review and critical audit byte-identical; explicit H2 refresh clears draft with zero automatic POSTs.                                                                  |
| Critical audit failure | Final-image real PostgreSQL FK failure rolls back Review insertion and update; caller receives failure. Separate proof PR `cmuvd19250001t301mp8o7ht4`.                                                                    |
| Verdict races          | Identical and competing same-head submissions serialize; one Review row; seven corresponding successful audit events in the transaction scenario; concurrent head update waits or stale verdict rejects.                  |
| Feedback failure       | Synthetic post-commit feedback failure preserves Review and critical audit.                                                                                                                                               |
| Replay                 | Concurrent reuse of existing decision/application/validation/ML/AI request IDs returns the same persisted identities without new work. Verdict intentionally remains ordinary upsert, not exactly-once.                   |
| Tenant/roles           | Foreign conversation/proposal/application/validation/workspace reads and verdict return scoped 404; anonymous verdict 401; developer final verdict 403 but conversation permitted; seeded self-approval 403.              |
| Public share           | Real isolated FULL readback has no collaboration/proposal/permission payload; share token cannot authenticate proposal or verdict writes (401).                                                                           |
| Provider outage        | Local deterministic HTTP 503 yields FAILED collaborator/provider-budget handling and FAILED AI re-review/PROVIDER_UNAVAILABLE; no fabricated assistant/result. Human verdict permission stays available.                  |
| ML outage              | Only new isolated ML container stopped; real worker persists two UNAVAILABLE assessments with null score/band/delta, then service restored. Human verdict remains available.                                              |
| Cancellation           | RUNNING slow-provider collaboration cancelled; remains CANCELLED after late provider settlement, without an assistant message.                                                                                            |
| Membership loss        | Developer membership removed during RUNNING slow collaboration; work becomes FAILED, no assistant is persisted; original membership restored.                                                                             |
| Validation failure     | Real original unit-test FAIL is preserved alongside patched PASS; cleanup DISPOSED. No all-subsystems-success requirement or fabricated test success.                                                                     |
| Non-mutation           | Original ReviewRun/findings/tool history and RAG tables retain canonical fingerprints; controlled source digest unchanged; Git index and HEAD unchanged.                                                                  |
| Restart                | All public table fingerprints identical across isolated terminal-state restart, including lineage, results and audits. Post-restart API and visible browser readback pass. Managed initializer has no pending migrations. |

### Additional Repeat: Uncertain Validation

After the successful final-image workflow and restart proof, an additional
complete repeat intended to exercise failed-refresh handling stopped before its
verdict stage. Validation `897b0367-929a-4998-90d3-7065df772be3` persisted
`FAILED`, cleanup `UNCERTAIN`, category `BROKER_OR_CLEANUP_UNCERTAIN`.
Its original typecheck passed with DISPOSED cleanup. The patched typecheck
persisted INFRASTRUCTURE_FAILED / INCONCLUSIVE, no exit code, and approximately
193 seconds observed duration despite the existing 30-second execution limit.
Docker later reported that executor exited 0, with no OOM. This does not upgrade
the persisted result to PASS: reliable completion/disposal was not acknowledged.
Subsequent diagnostic classification is H: environmental suspension with correct
fail-closed handling. Windows recorded host sleep from 14:56:49.318Z to
14:59:56.704Z and a 181.182-second clock adjustment on resume. The 193.153-second
measurement is broker-operation duration, not proven active TypeScript runtime.
Patched container wall lifetime was 192.438 seconds. Exact historical timer,
stream and cleanup exception ordering is not recoverable from retained logs.

Three direct authenticated controls used the same immutable broker/executor:
identical preserved patched input passed/DISPOSED in 14.007 seconds; minimal
typecheck passed/DISPOSED in 10.500 seconds; finite sandbox timeout returned
TIMEOUT/137/DISPOSED in 31.459 seconds, with Docker SIGKILL at approximately
30 seconds. These controls used the production broker-client library, not a new
BullMQ job. No product defect or Phase 3G regression was demonstrated. The new
canonical queued proof below supplies the previously outstanding integrated proof.

The resource journal retains one input volume plus two exited containers under
the Phase 3G namespace, nonce `89361669-b180-4235-9d2e-15383b5d78d9`. These
resources/history were not deleted, reset, reclassified or forced to DISPOSED.
No validation-broker or sandbox-policy source was changed. Earlier successful
canonical lineage remains unchanged and readable. The additional repeat made no
final Review or verdict audit mutation. Its persisted historical status remains
FAILED/UNCERTAIN/BROKER_OR_CLEANUP_UNCERTAIN permanently; later successes do not
reinterpret it. Original forensic resources and their signed journal remain
preserved. Standalone stale-refresh UI verification neither re-runs nor repairs
that uncertain candidate execution.

Exact Git reads use the existing verifier with correct blob hashing and a local
transport double. Unhandled Octokit requests fail closed; external fetch origins
are refused. The deterministic provider runs as a local HTTP service. No real
GitHub request, provider call, PR comment/review/branch update/merge/label write,
or external fixture PR #1 interaction occurred. `postToGithub=false` remained
enforced; no Github posting step was requested. Candidate RAG indexing and live
RAG in sealed AI re-review were not invoked.

The controlled source exists in memory, not a cloned fixture worktree: the proof
cannot certify external repository state by absence of local writes. It proves
non-mutation of the controlled source/transport and absence of external calls,
not an independent readback of a real GitHub repository.

## Regression Results

- Focused verdict/audit/nullable-history plus gate/feedback tests: 30 passed.
  New verdict tests: 17; audit helper tests: 2; nullable controller tests: 6.
- Complete `pnpm test`: passed. API: 42 files / 457 tests passed. Database:
  21 lifecycle/migration checks plus 1 AI migration check passed. Other workspace
  package/broker/executor suites passed; existing Docker-dependent skips retained.
- Python tests: 84 passed in a disposable Phase 3G-labeled container with the
  repository mounted read-only. Initial local Python lacked pytest; first
  container mount had the wrong directory depth and was corrected. No Python
  source/dependency lock was changed; existing warnings remain.
- Prisma validate/generate: passed. Sequential workspace typechecks: passed;
  final refresh correction web typecheck: passed.
- Production packages/API/web builds: passed, including final isolated Docker
  API/worker and web images. No build against proposed code escaped the certified
  validation profiles.
- New actual-browser workflow: seven grouped assertions passed on the prior images;
  reload and post-restart visible readback passed. Tested keyboard focus/Enter and
  390-pixel horizontal-overflow sanity passed, not exhaustive accessibility QA.
  An additional full repeat failed at uncertain validation as disclosed above;
  its later failed-refresh branch was not reached in that historical full run.
  The subsequent single canonical proof passed all seven groups, including
  failed-refresh handling, with a fresh acknowledged broker and new stage IDs.
  Separate actual-browser failed-refresh/reload verification passed: no decision
  controls during load failure, old draft discarded, H2 read after explicit reload,
  zero automatic verdict POSTs and unchanged Review/critical audit rows.
- Unchanged general browser walkthrough: 81 passed, 2 failed. Existing assertions
  require 91/CRITICAL while unchanged seed is 78/HIGH. These were not edited.
  Two expected sign-in HTTP 401 console diagnostics remain visible; this run had
  zero reported layout issues, not a claim that prior clipping debt was fixed.
- All 11 migration SQL files and migration lock are byte-identical to starting
  HEAD; migration/schema changes: zero. Baseline SHA-256:
  `e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.
- Baseline-relative tracked-file Prettier check: 145 failures at starting HEAD,
  145 currently, zero newly failing tracked files. Historical 142-file debt was
  an earlier measurement, not this revision's count. Existing Ruff debt remains
  unchanged; no Python source or Ruff configuration was edited.
  Current scoped Ruff check reports nine existing findings. Workspace regression
  totals 866 passed tests and seven existing skips across suites; focused 30 tests
  are a subset, not additional coverage. Python tests: 84 passed. Test-container
  setup initially lacked pytest and used an insufficient directory-depth mount;
  pinned test tooling and a full read-only repository mount corrected the harness,
  with networking disconnected for test execution. No product correction resulted.
- `git diff --check`: passed. Git index unchanged; working tree intentionally
  contains only proposed Phase 3G source/tests/documentation changes.
- Scoped generated JWT/encryption/broker key values: zero matches in proposed
  files and checked API/worker/web logs. No real external credentials loaded.
  This is scoped value matching, not universal secret non-leakage certification.

## Adversarial Review

Real findings corrected: stale refresh controls were enabled before refetch
completed; now fenced until successful explicit refresh. Empty-history routes
blocked first browser requests; user-approved explicit JSON null correction is
covered by six tests and real HTTP status/content-type/body assertions. Unrelated
formatting hunks were removed. Driver-only locator/readiness/schema-field errors
were corrected without weakening production authorization or assertions.

No new migration/domain, role relaxation, automatic verdict, provider budget
relaxation, GitHub write, candidate RAG path or sandbox-policy change entered the
diff. Tests do not equate mocked failure with transactional rollback: the real
PostgreSQL rollback scenario provides that evidence.

## Proposed Commit Inventory

1. `apps/api/src/audit-logs/audit.service.ts`
2. `apps/api/src/audit-logs/audit.service.test.ts`
3. `apps/api/src/collaboration/validation-ai.controller.ts`
4. `apps/api/src/collaboration/validation-ml.controller.ts`
5. `apps/api/src/collaboration/nullable-readback.controller.test.ts`
6. `apps/api/src/review-sessions/review-sessions.service.ts`
7. `apps/api/src/review-sessions/review-verdict.test.ts`
8. `apps/web/src/app/(app)/reviews/[id]/page.tsx`
9. `apps/web/src/lib/api.ts`
10. `apps/web/test/human-decision-loop.mjs`
11. `packages/shared/src/contracts/collaboration.ts`
12. `docs/phase3g-human-decision-loop.md`

Ignored `.codelens-tmp/phase3g/` contains local Compose/env/key files, deterministic
transport/provider drivers, DB/boundary/integrity/restart proof drivers, fingerprints
and screenshots. General browser-generated screenshots/report remain ignored.
None are proposed commit contents. Existing Docker exclusion rules exclude
`.codelens-tmp` and web proof drivers from production images. The new tracked
browser proof itself refuses execution without the exact project/output/URL guards.

Proposed subject: `fix(review): bind human verdicts to displayed head and atomic audit`.

## Exit Criteria and Claim Boundaries

A-O and Q are satisfied for the tested deterministic local workflow: coherent
human-authorized loop, immutable lineage, stale rejection, atomic audit, inspectable
evidence, truthful trust labels/degradation, human final verdict, authorization,
reload/restart, no external GitHub or candidate RAG/source mutation, zero migrations.
Workspace/Python/typecheck/build regression passes with the two explicitly
pre-existing browser test/seed drift failures disclosed; the browser suite is not
reported as entirely green. Unsupported validation was not separately recreated;
existing focused tests cover it. Uncertain cleanup occurred unexpectedly on the
historical repeat and remains preserved as uncertain, not rewritten as disposed.
Cancellation runtime evidence here is
collaboration-stage evidence, not every broker/ML/AI cancellation interleaving.
The environmental diagnostic and subsequent single awake-host canonical proof
close that outstanding execution-proof gap without changing product limits or
historical cleanup status. Scoped deterministic A-Q exit criteria are satisfied,
with P explicitly subject to existing debt rather than an entirely green browser
or formatting suite. This is readiness for human freeze review, not a new
production-safety, semantic-quality or hosted-CI claim.

Scoped certification wording:

> The tested deterministic CodeLens workflow connects investigation, human-reviewed
> patch proposals, isolated materialization, comparative validation, static and
> ML observations, bounded AI re-review and a human final PR verdict into one
> persistent, auditable decision loop under scoped local isolation.

It does not certify autonomous correctness, patch safety, exhaustive static
coverage, ML accuracy, semantic AI correctness, hostile multi-tenant production
sandbox safety, universal crash recovery, active-job draining, exactly-once
effects, GitHub write/webhook integration or external real-provider quality.

Preserved Phase 3C status:

- Deterministic verification: PASSED.
- Real Gemini investigation/tool/evidence: PARTIALLY VERIFIED.
- Real Gemini final grounded response/citations: NOT VERIFIED.
- Real Gemini multi-turn collaboration: NOT VERIFIED.

Phase 3F real-provider AI re-review remains NOT VERIFIED. This Phase 3G proof
made zero real provider calls and upgrades none of those claims. Hosted CI for
the uncommitted Phase 3G diff remains NOT RUN. No commit, push or next phase has
been started. The changes are ready for scoped human freeze review with the
historical environmental failure and limitations retained, not deployment
certification or a universal recovery guarantee.

## Resumed Canonical Proof

Exactly one new browser loop ran against
`codelens_phase3g_human_loop_20261005`. New broker namespace:
`codelens_phase3g_canonical_20261005`; new project volumes `canonical_control`
and `canonical_journal`. The API/worker mounted the new control volume read-only.
The original uncertain broker and its containers/volume/journal were excluded
from restart and remained untouched.

A temporary successful Windows SetThreadExecutionState request inhibited idle
system/display sleep without changing power configuration. Runtime/regression
proof interval: 2026-10-05T16:05:01.923Z to 2026-10-05T16:22:59.064Z; browser
loop ended 16:06:14.613Z. The guard started 16:03:26.5446177Z and remained active
through the interval. System-event query found zero matching sleep/resume events.
Administrator-only `powercfg /requests` readback was unavailable; guard API
success/process lifetime plus accessible event-log evidence establish this scoped
awake-host proof. Manual/forced future suspend prevention is not certified.

### Canonical Identities

| Object                          | ID                                     |
| ------------------------------- | -------------------------------------- |
| Conversation                    | `cmuvfxu7d0003r101367ixcqf`            |
| Turn                            | `cmuvfxubk0007r101my64383r`            |
| Proposal, ACCEPTED              | `cmuvfxupb000bo301qscrjf7n`            |
| Application, APPLIED/DISPOSED   | `d44ea5b8-19d7-4514-bb22-6f9088beceba` |
| Validation, COMPLETED/DISPOSED  | `c843dc4c-16d4-4552-8cdb-dedc9a59d8b6` |
| ORIGINAL static analysis        | `5d056fa1-09a0-4a40-b6a0-4dbe5f64fc0e` |
| PATCHED static analysis         | `3977612f-ce11-4d9f-819d-af983aa091dc` |
| Resolved static occurrence      | `c7e9956a-7ada-45cf-baa7-a31975ef1b14` |
| ML comparison                   | `604f7514-d453-4f18-9253-c1e7aab176aa` |
| AI re-review                    | `9129bf02-58a2-4e6b-a225-28c85fd6ed10` |
| AI attempt                      | `cf25b6b3-85a7-486c-b11f-8c2d4b85ca9d` |
| Final Review, CHANGES_REQUESTED | `cmuvc4dbl002bn9019qbe4oe1`            |

PR/organization/repository/original analysis remain the controlled #447 fixture
listed above. Final Review intentionally reuses the existing reviewer/head upsert
identity, with three successful browser verdict audit events after this proof.
No claim of a fresh Review row or exactly-once verdict submission is made.

- Proposal digest: `d5110296f0c5a0dcda97e0fb5b09833754bde201b6f350448615c3488e0bef09`.
- Snapshot digest: `7aaf256926d676f44ffbe6136f13f381412a0d9584b01743a723adae42661d4d`.
- Candidate digest: `a01888a51988313dafb993c2ec2fe47474fa6b53515911a3ae521275d6a1db6b`.
- AI packet digest: `ff8db7ecfc2247683b2dd6d80701eecf4aac23824c5df744ef1eafa86ec0fb4d`.
- Cited summary evidence: `ef88e5c71f15a3758b8ed7093992b7e7c7dde4760441e83399ade43bbdb5dd18`.

### Validation Timing

Requested: 16:05:08.613Z; queued audit: 16:05:08.627Z; claimed audit:
16:05:08.678Z; completed: 16:05:55.394Z. All timestamps are UTC on 2026-10-05.

| Side/profile        | Step interval                 | Broker observation | Outcome      | Cleanup  |
| ------------------- | ----------------------------- | -----------------: | ------------ | -------- |
| ORIGINAL TypeScript | 16:05:08.713Z - 16:05:22.488Z |            13.648s | PASS, exit 0 | DISPOSED |
| PATCHED TypeScript  | 16:05:22.536Z - 16:05:45.645Z |            22.853s | PASS, exit 0 | DISPOSED |
| ORIGINAL unit tests | 16:05:45.664Z - 16:05:50.437Z |             4.701s | FAIL, exit 1 | DISPOSED |
| PATCHED unit tests  | 16:05:50.449Z - 16:05:55.011Z |             4.424s | PASS, exit 0 | DISPOSED |

These durations include broker preparation, execution observation and cleanup;
active compiler/test CPU duration and cleanup-only duration are not separately
instrumented. No misleading command-duration claim is substituted. All broker
observations were bounded below the unchanged 30-second execution-phase timer;
all four signed results acknowledged disposal, no OOM, and complete capture.
No new UNCERTAIN outcome occurred.

### Static, ML and AI

One eval occurrence is RESOLVED and none INTRODUCED. RESOLVED means no longer
detected by this ruleset, not a proven vulnerability fix. UNCHANGED, CHANGED and
INCOMPARABLE semantics retain automated coverage; this fixture does not exercise
every outcome at runtime.

ML: ORIGINAL 84.3/HIGH, PATCHED 79.5/HIGH, delta -4.8, LOWER score, UNCHANGED
band. Both AVAILABLE, warnings empty. Model xgboost/bootstrap-v1, baseline shared
bundle, local-unattested runtime. Artifact digest
`4652bec9214db4ede72bc26f6c286787178a3125eb028dd0ef38bdc1314117f4`;
preprocessing `6f20827a9fb8cc780d2f45783bff288b2dd29bc505c540895954e7f820b9a953`;
feature schema `codelens-risk-features-v1`. Lower score is advisory, not proven
safer. Exact stored model/calibration/runtime/feature/extractor identities are
retained in ignored readback evidence.

AI: deterministic INCONCLUSIVE, sealed packet with 15 persisted/read-back
references: LINEAGE, DECISION, PATCH, BROKER, RUNNER, STATIC_ANALYSIS, ML and
STATIC_FINDING. Summary citation resolves within the sealed packet; no original
conversation/AI evidence, live RAG, tools or repository retrieval is admitted.
One request, zero retry/repair/unknown requests, 2048 reserved tokens, provider-
reported prompt/completion 100/100. Reported token accounting is not tokenizer-
certified usage. Limitation: deterministic harness, no semantic quality or patch
safety claim. Human final verdict remains CHANGES_REQUESTED because the actual
PR branch was never modified.

### Repeated Boundaries and Persistence

Canonical stale-head POST returns typed 409 and leaves Review/critical audit
unchanged; controls block, explicit failed refresh removes them, successful
manual reload reads H2 and discards draft with zero automatic submissions.

Separate real PostgreSQL proof PR #452 `cmuvg4ylu0001s801e0czbqyj` proves Review

- critical audit commit, insertion/update rollback on forced critical audit FK
  failure, serialized identical/competing verdicts, head-move fencing and seven
  successful corresponding events. Post-commit feedback failure retains the
  committed Review/audit. The first harness invocation reused preserved #451 and
  failed its fixture creation with P2002; only the ignored harness number changed
  to fresh #452. No production fix, silent row reset, or canonical-loop rerun.

Empty-history ML/AI GETs each return status 200, JSON content type and the exact
four-byte body `null`; nonempty canonical histories return valid JSON objects.
Read-only fixture validation `8c14b23d-e6fa-4be1-b9d0-ceeb097a7bd6` supplies empty
history; no synthetic schema or execution change was required.

Re-exercised tenant/role/share boundaries and concurrent decision/application/
validation/ML/AI request-ID reuse pass. Developer investigation allowed, developer
final verdict denied, reviewer verdict allowed, author self-approval denied,
foreign tenant scoped 404, anonymous 401, public share cannot authorize writes.
Membership loss during slow collaboration fails without an assistant; cancellation
stays terminal after late settlement. Local provider outage persists no fabricated
answer/assessment. Prior isolated ML-outage evidence is retained, not rerun:
two unavailable/null assessments and no fake delta, with human verdict permitted.

Canonical reload passed before degradation checks. After separate provider-outage
proof, the UI truthfully shows the latest FAILED/No assessment; the prior canonical
AI result/citations persist through scoped ID-based API readback. The panel displays
latest review rather than a full selectable AI-history archive; record this as
Phase 4 UX debt, not lost persistence or a fabricated success.

All application-table fingerprints match across isolated terminal-state restart.
Managed initializer: 11 migrations, no pending migration, RAG readiness passes.
Post-restart browser proposal/static/verdict/latest-failure view and scoped
canonical AI/citation readback pass. Original ReviewRun/findings/tool history,
RAG tables and controlled source fingerprints remain unchanged. Historical
uncertain broker/resources are explicitly excluded from restart.

### Final Regression and Limits

Focused 30, API 457, AI-agent 111, workspace aggregate 866 passed with seven
existing skips; Python 84 passed. Prisma validation/generation, sequential
typechecks, production packages/API/web and scoped Docker API/worker/web builds
passed. Existing browser walkthrough: 81 passed, two unchanged risk-fixture
failures, two expected sign-in 401 diagnostics and zero reported layout issues.
Prettier tracked baseline/current: 145/145, zero new failures; Ruff nine existing
findings. No unrelated debt or known 91/CRITICAL vs 78/HIGH mismatch changed.

Canonical screenshots and keyboard/390px overflow checks are scoped sanity checks,
not exhaustive responsive/accessibility coverage. The captured narrow viewport
shows navigation/conversation-list content, not every nested proposal control.
No prior clipping observation is suppressed or declared universally fixed.
The optional 21st review CLI/design context was unavailable; no tooling was
installed and no redesign undertaken.

Runtime API/worker image: `sha256:f177bc9038d084c6b71e395b36263fa454242688dffa274c2fcef491ed451462`;
runtime web: `sha256:2f9dd315cfa7795c0ca01dce3b9cf976957a5f104b2aeabca7a31473ae46eb17`.
Docker build verification later succeeded from the same frozen source; restart
kept the running images rather than implying the rebuilt web image underwent a
second canonical loop. Broker/executor remain the immutable diagnostic identities.

No real provider call, GitHub write/comment/review/merge/branch mutation, candidate
RAG indexing, repository/source mutation, automatic acceptance/verdict/merge,
schema change, migration change, commit or push occurred. Source/GitHub proof uses
controlled transport, not independent real-GitHub state readback. The 116 older
containers and 63 older volumes checked by the existing inventory remain present.
Scoped credential-value matching in proposed files and API/worker/web logs found
zero matches; this is not universal secret-safety certification.

The proposed inventory remains exactly 12 files; only this evidence document
changed during resumption. Ignored canonical/diagnostic Compose/env/keys/drivers,
screenshots, reports, and temporary runtime material remain excluded. All 11
migrations and migration lock remain byte-identical, baseline hash unchanged.
Deterministic exit criteria PASSED; ready for human freeze review, STOP BEFORE
COMMIT. Existing real-provider and hostile-code-isolation limitations remain.
