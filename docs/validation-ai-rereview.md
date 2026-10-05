# Bounded evidence-grounded AI re-review

## Semantics

AI re-review is an advisory assessment grounded in the persisted validation evidence. It does not approve, merge, or certify the patch.

Lifecycle (`QUEUED`, `PREPARING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`) is separate from assessment (`ACCEPTABLE`, `NEEDS_CHANGES`, `INCONCLUSIVE`). `COMPLETED` means a validated result was persisted, not passed. `ACCEPTABLE` means no material concern identified within the supplied scope, not safe, correct, applied, tested exhaustively, or approved. Existing proposal decisions, validation outcomes, static results, ML comparisons, review verdicts and gates are not changed.

## Persistence and migration

The additive migration `20261005010000_validation_ai_rereviews` creates `ValidationAiReview`, `ValidationAiReviewAttempt` and normalized `ValidationAiEvidenceReference` rows. Existing migrations and the migration lock are unchanged. No historical backfill, seed, `db push`, reset, or startup DDL is introduced. API startup checks readiness only.

A reservation pins the tenant, repository, PR, validation, application, accepted proposal revision/digest, exact base/head, snapshot/candidate digests, two static analysis IDs, one terminal ML comparison, provider/model/configuration identity, versions and deadline. PostgreSQL guards lineage, transitions, one active review per validation, attempt fencing, sealed references and terminal immutability. One execution generation is allowed. No DB transaction spans provider HTTP.

## Evidence packet

Versions: `validation-ai-evidence-v1`, `validation-ai-review-v1`, `validation-ai-result-v1`.

The server builds and seals the packet from persisted data only, then reconstructs it from persisted references and checks its SHA-256 digest before dispatch and finalization. Stable ordering and canonical JSON digesting make equivalent persisted inputs deterministic. Evidence IDs bind lineage, source ID, trust and sanitized payload digest.

Included evidence:

- Server-controlled lineage and accepted human proposal decision.
- Canonical diffs from immutable proposal files, tied to exact old blob/content and resulting content hashes. Every modified file must match the applied whole-snapshot manifest; unchanged manifest files are permitted, duplicate paths are not.
- Broker observations, separately labeled from untrusted runner-reported summaries.
- Original/patched static analysis status, ruleset/configuration/source/result identity, and bounded occurrence observations with comparison classifications.
- One persisted terminal ML comparison, including available/unavailable assessments and frozen identity where available. Lower ML score is not a safety claim or vulnerability probability.

Trust classes are `SERVER_LINEAGE`, `EXACT_REVISION_SOURCE`, `DETERMINISTIC_DERIVED`, `BROKER_OBSERVATION`, `UNTRUSTED_RUNNER_REPORT`, `ADVISORY_ML`, `HUMAN_DECISION`. A trust label describes provenance, not semantic truth. Static `RESOLVED` means no longer detected, not fixed. Incomplete coverage is not complete zero findings.

Original AI reviews, collaboration messages, live RAG, indexed context, source excerpts, raw runner output, repository searches and arbitrary file reads are excluded. The re-review service has no GitHub client, RAG service, tool registry or executor dependency. It neither reads nor writes candidate RAG indexes. Proposal diffs are the only exact-source representation; whole-file source retrieval is deferred.

## Bounds and redaction

- At most 100 evidence entries; at most 40 optional static occurrences per side.
- Canonical patch text at most 20 KiB; static entries at most 8 KiB; ML payload at most 4 KiB.
- Packet at most 28 KiB, reserving framing space; complete serialized messages at most 32 KiB. Mandatory evidence overflow fails, never truncates a patch. Optional static omissions are deterministic and explicitly counted.
- Provider response body and result text each at most 16 KiB. Streaming transport cancels oversized success/error bodies before retaining an unbounded response.
- Two total provider wire requests, one primary and at most one retry **or** repair. Repair uses the same packet and generic feedback, never echoes invalid output. No fallback provider, tools, collaborator loop, new patch or budget relaxation.
- Per-request deadline 25 seconds; total deadline 60 seconds from reservation, including queue/preparation time. Each dispatch reserves 2,048 output tokens; maximum reservation 4,096. These are request settings/accounting limits, not proof of a provider's billing or token-limit implementation.

Packet strings are sanitized before digesting/persistence. Known configured provider, Gemini, signing/encryption and GitHub secret values plus existing diagnostic patterns are redacted. Validated output text and reported model identity are sanitized too. No prompts, full source, raw errors, credentials or result bodies enter audit metadata. Redaction is not universal secret detection. Server capability exclusion and strict output parsing constrain injection; they do not prove that a model reasons correctly about adversarial text.

## Output, citations and accounting

Output is strict JSON: assessment; cited summary; bounded addressed, residual and introduced concerns; bounded suggested follow-ups; nonempty limitations. Every claim has 1-8 unique included evidence IDs. Each concern list has at most 10 entries; claim text at most 700 characters. Unknown fields, action/tool/patch/command payloads and absent/foreign/omitted references are rejected. Citation membership proves resolvability, not entailment or answer quality. No hidden chain-of-thought is requested or exposed.

Request/repair/retry counts, reserved output tokens, reported prompt/completion tokens, unknown-usage requests, duration, requested identity and available reported identity are persisted. Before dispatch, usage is conservatively unknown. Missing usage remains `null`, never fabricated zero; known totals may coexist with an explicit unknown-request count. Accounting is not exact billing. Rejected output cannot persist a partial assessment; its reported model may still be recorded. Cross-process cancellation can prevent the final checkpoint, leaving conservative reservations instead of invented actual usage.

## API, authorization and fencing

All endpoints are under `/api/v1/validations/:id/ai-rereview` and require authentication, current membership and at least `DEVELOPER` (repository role ordering applies):

- `POST` with strict `{requestId: UUID}` reserves/replays a review; 202, throttled to five per minute.
- `GET` reads latest, or `?reviewId=UUID` reads a scoped historical review.
- `POST /:reviewId/cancel` with strict `{requestId: UUID}` cancels active work; repeated cancellation is idempotent. Other terminal results are not rewritten.

Client-supplied scope, provider/model, verdicts and tools are not accepted. Foreign resources return scoped 404. Request identity is tenant/user/UUID-bound; conflicting reuse is rejected. PostgreSQL reservation locking and a partial unique index exclude competing active reviews. BullMQ jobs carry only `reviewId`, deterministic job identity and one queue attempt. Duplicate worker delivery cannot claim another execution fence.

Every dispatch/checkpoint rechecks policy/configuration and live membership/fence/deadline. Cancellation aborts local transport; a database poll handles cancellation by another process. PostgreSQL, not queue state, is authoritative. Reconciliation re-enqueues queued work and expires interrupted work without another provider execution. An uncertain upstream request is not automatically repeated after a crash. This is not exactly-once provider execution, instantaneous crash recovery, or guaranteed upstream cancellation.

Readback compares the current PR head to the pinned historical head. Stale results retain their original packet/result; no rebasing, repinning, automatic rerun or applicability claim occurs. Safe audit events record request, packet build, dispatch/repair, completion, failure and cancellation using identifiers, digests, state and counts only.

## Frontend

The existing validation workspace shows the disclaimer, lifecycle/assessment, requested/reported identity, cited claims, typed evidence, coverage/omissions, lineage/digests, accounting, stale state and failure category. Request/cancel are the only new actions. A failed review says no assessment and preserves deterministic evidence. Citation links resolve to persisted evidence. No new Apply/Run/Commit/Push/Merge/Approve control or automatic human decision is introduced.

## Deterministic verification

Isolated project: `codelens_phase3f_ai_rereview_20261005`; API `127.0.0.1:55409`, web `127.0.0.1:53409`. New project-prefixed PostgreSQL/Redis and broker volumes were used. Original, C2 and prior validation resources were not reused as mutable runtime resources. Existing immutable broker/ML images were reused with isolated containers and journals. Test drivers, environment, screenshots and generated evidence remain under ignored `.codelens-tmp/phase3f-ai`; repository test fixtures/browser driver are excluded from production images by existing Docker exclusions.

The fresh-volume proof applied the ten certified migrations, verified all application tables empty, explicitly seeded the isolated database and constructed prior conversation/evidence/application/paired-validation/static/ML state. Adding migration eleven preserved all prior table fingerprints, including identity data, and created empty AI tables. A separate fresh database applied all eleven migrations with all application tables empty.

The real API/BullMQ/Redis/PostgreSQL path used an internal deterministic HTTP provider harness through the normal OpenAI-compatible transport: successful cited `INCONCLUSIVE`; invalid output repaired once; transient 503 retried once; 25-second timeout failed; fabricated citation rejected after one repair; outage failed after two requests; missing usage persisted as unknown; active cancellation persisted without an assessment. These are synthetic provider responses, not real OpenAI/Gemini evidence. Additional concurrent API reservations proved same-UUID replay and competing active exclusion. A controlled PR-head movement preserved pinned historical identity and produced truthful browser stale labeling.

Browser proof covered keyboard initiation/completion, advisory disclaimer, summary/citation navigation, excluded coverage, reload persistence, stale indication, failure messaging and absence of new mutation controls. This is a narrow tested flow, not exhaustive accessibility/browser certification.

Direct PostgreSQL mutation attempts against terminal review, sealed evidence and completed attempt were rejected. Post-runtime product fingerprints matched prior state for proposals, applications, conversations/evidence, paired/static/ML validation, review/report/gate and RAG data. Exclusions: new AI tables, intentionally configured AI settings, audit history and `User` activity timestamps from ordinary sign-in. The pre/post-migration preservation check included `User` without this exclusion. No repository or Git index write is performed by re-review; no GitHub client or external GitHub/provider call is used by its runtime proof.

Restart preserved every review, attempt and evidence row byte-for-byte. Repeated migration deployment found eleven migrations and no pending migration. Production builds and sequential workspace typechecks passed. The existing virtual environment passed all 84 Python tests (host Python lacked ML dependencies, and the production ML image did not include pytest). Regression commands: `pnpm test`, `pnpm db:validate`, `pnpm db:generate`, `pnpm -r --workspace-concurrency=1 --if-present typecheck`, `pnpm build`, `.venv/Scripts/python.exe -m pytest apps/ml-service/tests`, focused provider/API tests, scoped Docker builds, guarded `apps/web/test/validation-ai.mjs`, `git diff --check`.

## Claim boundaries

Deterministic AI re-review implementation/provider mechanics: verified within the recorded local test/runtime scope. Real-provider AI re-review and semantic groundedness: **NOT VERIFIED**. No real provider request was authorized or made for this slice. Citation membership is not semantic entailment; runner reports are untrusted; tests are not trustworthy safety certificates; ML is advisory; secret detection is bounded; hostile multi-tenant production isolation, universal crash recovery and exactly-once external effects are not certified. Hosted CI for this uncommitted revision is **NOT VERIFIED**.

Existing Phase 3C claims remain unchanged: deterministic verification **PASSED**; real Gemini investigation/tool/evidence **PARTIALLY VERIFIED**; real Gemini final grounded response/citations **NOT VERIFIED**; real Gemini multi-turn collaboration **NOT VERIFIED**. Known walkthrough `91/CRITICAL` versus unchanged-seed `78/HIGH` drift, expected sign-in diagnostics, clipping observations and existing Prettier/Ruff debt remain untouched. No Phase 3G, RAG, tool invocation, patch generation, automatic gate/verdict, GitHub posting or merge functionality is included.

## Freeze evidence (2026-10-05)

Starting and final HEAD: `e24d5489982acf0b8c0381f4caf9e89318d29919`. Nothing staged, committed or pushed. The proposed changeset has **33 files** (13 modified, 20 new), including one additive migration and this document. Local proof/runtime material remains ignored.

All ten previous migration SQL files and `migration_lock.toml` were compared byte-for-byte to HEAD. Baseline SHA-256: `e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.

Final API/worker image: `sha256:b28f60850a2aa943f2c87a85a4b87affd73e7e7f7468131fa76b235426096942`. Web image: `sha256:014f72820b60705f822a9efadba6ec52856332eec3532e5bf283742e0c8b2a00`. The former was rebuilt and the eight-case matrix and keyboard/browser flow repeated after final accounting/audit changes. Formatting of new web code was semantic-only relative to the browser-tested image.

Final matrix: 12 local provider HTTP requests across eight API scenarios; one additional browser request; 13 observed requests since the final provider harness restart. Across all verification runs, PostgreSQL contains 29 review attempts reserving 42 requests; reservations are conservative and not an upstream billing assertion. No real provider calls occurred. Checked isolated API/worker/web/provider logs and proposed files contained zero supplied local credential-value matches; injected source text was absent from checked logs. Read-only inventory checks retained all 107 prior container identities and all 57 prior volumes. No original/C2 runtime was changed.

Regression results:

| Suite / check                             | Result                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| Workspace tests                           | PASS: 841 tests; 7 existing platform/backend skips                             |
| AI-agent                                  | 111 PASS, including 23 review-only protocol and 6 bounded transport tests      |
| API                                       | 432 PASS, including 18 packet, 12 service, 3 provider-policy and 1 queue tests |
| Database                                  | 22 PASS, including new migration contract test                                 |
| Static analysis                           | 47 PASS                                                                        |
| RAG / GitHub packages                     | 29 / 81 PASS; deterministic tests, no external calls                           |
| Python                                    | 84 PASS using existing `.venv`; existing deprecation warnings retained         |
| Prisma validate/generate                  | PASS                                                                           |
| Sequential workspace typechecks           | PASS                                                                           |
| Production package/API/web builds         | PASS                                                                           |
| Isolated API/worker and web Docker builds | PASS                                                                           |
| Browser proof                             | PASS: initiation/completion, failure, stale, citation navigation and reload    |
| Upgrade/fresh/repeat deploy/restart       | PASS                                                                           |
| New scoped Prettier files / whitespace    | PASS; existing debt not mass-formatted                                         |

Adversarial corrections made within this slice:

- Real runtime exposed a whole-snapshot versus modified-file manifest assumption. The guard now verifies the modified-file subset with exact hashes and rejects duplicate manifest paths; added regression and runtime proof pass.
- Message framing bounds are checked before dispatch reservation; no impossible oversized dispatch is counted as a wire request.
- Invalid output retains safe reported model metadata where available but never an assessment or partial result.
- Duration is not counted twice if a persistence checkpoint fails. Known-secret collection covers signing/encryption/GitHub and embedding credentials in addition to review-provider keys. Audit metadata includes bounded identity/version/accounting fields, never packet/source/output.

The local driver was corrected to use the existing `/auth/signin`, role ordering and HTTP 422 validation contract. Product authentication/roles/validation behavior were not altered. Post-browser fingerprint exclusions for ordinary user activity are disclosed above; all prior tables were included in the separate migration-preservation check. No pre-existing risk assertion/seed drift or formatting debt was changed to obtain green results.

### Exact proposed inventory

```text
apps/api/src/collaboration/collaboration.module.ts
apps/api/src/collaboration/validation-ai-content.test.ts
apps/api/src/collaboration/validation-ai-content.ts
apps/api/src/collaboration/validation-ai-provider.service.test.ts
apps/api/src/collaboration/validation-ai-provider.service.ts
apps/api/src/collaboration/validation-ai.controller.ts
apps/api/src/collaboration/validation-ai.service.test.ts
apps/api/src/collaboration/validation-ai.service.ts
apps/api/src/queues/application-shutdown.ts
apps/api/src/queues/processors/validation-ai.processor.ts
apps/api/src/queues/queues.module.ts
apps/api/src/queues/validation-ai.queue.test.ts
apps/api/src/queues/validation-ai.queue.ts
apps/api/src/queues/workers.module.ts
apps/api/test/validation-ai-fixture.ts
apps/web/src/components/workspace/validation-ai-panel.tsx
apps/web/src/components/workspace/validation-panel.tsx
apps/web/src/lib/api.ts
apps/web/test/validation-ai.mjs
docs/validation-ai-rereview.md
packages/ai-agent/src/index.ts
packages/ai-agent/src/providers.ts
packages/ai-agent/src/validation-ai-transport.test.ts
packages/ai-agent/src/validation-ai.test.ts
packages/ai-agent/src/validation-ai.ts
packages/database/package.json
packages/database/prisma/migrations/20261005010000_validation_ai_rereviews/migration.sql
packages/database/prisma/schema.prisma
packages/database/src/client.ts
packages/database/test/validation-ai-migration.test.ts
packages/shared/src/contracts/ai-review.ts
packages/shared/src/contracts/validation-ai.ts
packages/shared/src/index.ts
```

Proposed subject: `feat(collaboration): add bounded evidence-grounded validation AI re-review`.

Scoped deterministic implementation/runtime exit criteria: **PASSED**, with the explicit exclusions and limitations above. Real-provider re-review/semantic quality and exact-revision hosted CI remain **NOT VERIFIED**. Stop before commit/push; no next phase is started.
