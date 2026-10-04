# Phase 3E Proper: Isolated Accepted Patch Applications

Deterministic implementation and isolated runtime verification: **PASSED**.
Starting foundation: `e97f042240d8c01455e7ee9b457126e3e541a27b`.
This changeset remains uncommitted; new exact-revision hosted CI is NOT VERIFIED.

## Meaning and Boundaries

APPLIED means the accepted immutable proposal was reconstructed against its pinned
exact revision, materialized inside the restricted executor, its complete result
manifest verified, and its ephemeral candidate workspace disposed. It is not an
assertion of correctness, safety, testing, building, validation, repository
application, commit, push, merge or PR update.

No candidate installs, tests, builds, lint, static analysis, AI re-review or arbitrary
commands exist. No repository write, branch, commit, push, GitHub write or Phase 3F
functionality is added. The executor still has one fixed materialization command.

## Domain and Migration

Only additive migration `20261003030000_patch_applications` is added. It creates:

- PatchApplication: immutable tenant/proposal/turn/repository/PR/conversation scope,
  human actor, actor-scoped request UUID/hash, proposal revision/digest, paired pins,
  server deployment image/policy, trace, fixed deadline and lifecycle/cleanup state.
- PatchApplicationAttempt: generation one, retained queue identity, unpredictable
  claim fence, persisted broker nonce, deadline, lifecycle and snapshot/manifest hashes.
- PatchApplicationFileResult: scoped normalized path, old Git/content hashes, result
  content hash and byte length. No whole file, source, replacement or patch is stored.

Composite scoped foreign keys use RESTRICT. Unique constraints fence request reuse,
active applications/attempts and result paths. Database guards protect immutable
identity, terminal rows, fences and file results; APPLIED requires DISPOSED and
completion within the original deadline. Attempt generation is explicitly one.
The migration was applied to the isolated upgrade and fresh databases and is now
immutable. All six previous migrations and migration_lock.toml remain byte-identical.
Baseline SHA-256:
`e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.

## API and Authorization

- POST `/api/v1/patch-proposals/:id/applications`: requestId, expectedProposalRevision
  and expectedProposalDigest only; strict schema; 202 readback.
- GET `/api/v1/patch-applications/:id`: scoped persistent metadata/readback.
- POST `/api/v1/patch-applications/:id/cancel`: strict request UUID; current human
  authorization; idempotent cancelled-state readback.
- GET `/api/v1/patch-proposals/:id/applications`: scoped ID-keyset pagination,
  default 25, bounded limit and scoped cursor validation.

All routes require authentication and current DEVELOPER-or-higher membership.
Foreign identities return scoped 404. There is no public-share or model application
route. Readback contains pins, state, attempt/hash metadata, stale observation and
explicit materialization-only limitations; not source, credentials or launch options.

## Identity, Queue and Fencing

The database transaction serializes actor/tenant/request identity using a PostgreSQL
advisory lock, then proposal/application row locks and current membership locks.
Identical request replay returns the same application, including terminal replay;
conflicting reuse rejects. A new request for an active or cleanup-uncertain proposal
rejects. Concurrent identical API requests runtime-proved one identity.

Database commit precedes Redis enqueue. The dedicated patch-application queue carries
organization/application/attempt identifiers only. Deterministic retained job IDs,
one BullMQ attempt and database execution fencing prevent replay relaunch. The worker
reconciles committed-but-not-enqueued QUEUED rows and expires old active rows. Redis
enqueue waits are bounded/coalesced with a 50-operation cap; late settlement is handled.
PostgreSQL, not Redis retention, owns application identity.

Only the dedicated worker runs this consumer, even if other workers are enabled in
the API. Worker concurrency is one. A claim changes QUEUED to PREPARING with a random
fence. Proposal/app locks have consistent ordering. Network source reads occur outside
database transactions. Checks repeat before launch and finalization; cancellation,
membership loss, supersession and expired deadlines fence results. Active-attempt
uniqueness and immutable fences also exist in the database.

No automatic retry or retry endpoint exists. Deterministic and infrastructure failures
terminate this logical application; a new explicit human request is allowed only when
the earlier cleanup is not uncertain. Crashed PREPARING/APPLYING rows expire without
relaunch. Active host-SIGKILL recovery is not runtime-proven. No exactly-once claim.

## Source, Broker and Result Flow

1. Revalidate persisted accepted proposal identity, scope, paired pins, evidence
   usability/linkage, current requesting-human membership and deployment metadata.
2. Obtain that human's GitHub client; use the existing complete exact Git snapshot
   at the immutable pinned head. No clone, checkout, host path or AnalysisSandbox fallback.
3. Strictly parse persisted structured intent and rebuild using shared canonical
   patch-core logic; independently verify old blobs/content, proposal digest and all
   expected candidate hashes. All source/replacements stay in memory.
4. Recheck under locks, change to APPLYING/UNCERTAIN, send only the existing typed
   materialization payload through the authenticated fixed Unix-socket broker client.
5. Verify signed response nonce and actual deployment image/policy attestation; reject
   missing/mismatched attestation. Verify complete ordered manifest, source/proposal
   digests, hashes, sizes, uniqueness and absence of extra/missing files.
6. The broker returns MATERIALIZED only after successful executor removal. Under the
   current fence/deadline/eligibility/membership, atomically persist bounded metadata
   and APPLIED/DISPOSED plus audit. Never persist an unverified partial manifest.

The minimal foundation adjustment signs actual fixed deployment identity. Legacy
broker-client verification remains compatible; PatchApplication requires the stronger
proof. Launcher, seccomp, command, mounts, network/resources and executor policy are
not widened. Operator configuration uses a pinned image ID and broker-key secret;
neither is chosen by the API client. Only the broker mounts the Docker socket.

Snapshot policy remains UTF-8 regular mode 100644 only, complete tree verification,
at most 1,000 files/2,000 entries/depth 16, 1 MiB per blob, 16 MiB source and 20 MiB
candidate payload. Unsupported objects fail the snapshot rather than being omitted.

## Cancellation, Disposal and Staleness

The original 150-second logical deadline includes queue/preparation. Cancellation
atomically makes the application terminal; the worker monitor aborts only its broker
connection, causing broker-owned executor termination/disposal. Late snapshot or
signed result cannot revive it. Preparation cancellation retains NOT_STARTED;
materialization cancellation conservatively retains UNCERTAIN when signed cleanup
acknowledgement is lost. Actual Docker removal does not retroactively rewrite the
terminal row. A subsequent request is blocked while uncertainty remains; no operator
override or automatic certainty-reconciliation endpoint is implemented.

No workspace/download is retained. Metadata remains after disposal. Stale compares
pinned head with recorded PR head; it does not fetch a live head, rebase or mutate
proposal/application. Historical materialization is allowed and explicitly labelled.

## Frontend and Audit

The existing proposal card hosts a scoped application panel. ACCEPTED proposals can
show "Prepare isolated application"; active/uncertain readback disables another
request. Request UUID is retained across an uncertain response. Polling displays
Queued, Preparing, Materializing, Applied in isolated workspace, Disposed, Failed or
Cancelled, with cancellation for active work. Reload reads persistent state. Result
details contain bounded hashes, deployment and file metadata, never candidate source.
APPLIED uses the exact explanatory sentence required by Phase 3E. No Apply, Run,
Commit, Push or Merge control is added.

Transactional audits contain bounded IDs, actor/trace/request/broker correlation,
revision/digests, image/policy, status, cleanup, category and file count. No source,
patch, replacement, prompt, environment or raw exception is logged. Raw broker errors
are reduced to bounded categories. Checked application audit rows contained no source.

## Verification Evidence

Only new project `codelens_phase3e_application_20261003` was used. PostgreSQL, Redis,
control and journal volumes belong to that project. API/web bind localhost 54405/53405.
No original/previous-phase container, volume or fixture GitHub resource was modified.
The read-only synthetic Git transport supplied real exact-SHA/tree/blob structures;
production snapshot verification, patch core, API, PostgreSQL, Redis/BullMQ, worker,
broker and restricted executor were real. A transport hook refuses external requests.
There were no real provider or authenticated GitHub calls.

| Proof                          | Result                                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation upgrade             | Exact six foundation migrations, explicit isolated seed and historical accepted proposals; all prior-table fingerprints unchanged after migration seven                                                             |
| Fresh lifecycle                | Seven normal migrations, every application table empty before any seed; no db push/reset/manual schema creation                                                                                                     |
| Real queued application        | Authenticated API to real Redis/BullMQ worker and signed broker; APPLIED/DISPOSED; all 901 snapshot files verified                                                                                                  |
| Final image replay/concurrency | Eight identical parallel requests produce one application; conflicting reuse rejects; accepted proposal unchanged                                                                                                   |
| Authorization/injection        | Foreign read/request/cancel denied; anonymous denied; command/image/network/mount/environment/tenant fields rejected                                                                                                |
| Cancellation                   | Final-image PREPARING and APPLYING cancellation; no late revival/results; UNCERTAIN blocks another request                                                                                                          |
| Queue restart                  | Worker stopped; identifier-only job persisted; replacement start consumes same retained job and reaches APPLIED/DISPOSED                                                                                            |
| Staleness/pagination           | Historical pins preserved; stale API/browser indication; two distinct scoped pages and foreign cursor denial                                                                                                        |
| Executor inspection            | Actual non-root 65532, network none, read-only root, cap-drop ALL, no-new-privileges/seccomp, 64 PIDs, 0.5 CPU, 512 MiB, no bind/volume mount, noexec/nosuid/nodev tmpfs, fixed sanitized environment, logging none |
| Disposal                       | No executor labelled with this isolated broker namespace remains after completion/cancellation                                                                                                                      |
| Persistence/immutability       | Real DB identity/fence/result mutation guards reject; normal stack restart leaves application/attempt/result readback byte-equivalent                                                                               |
| Non-mutation                   | HEAD, Git index, refs and tracked/new source fingerprints unchanged across final runtime window                                                                                                                     |
| Focused browser                | Seven passed; keyboard request, explicit semantics, stale warning, unchanged canonical diff, no execution controls, reload/hash readback, 390px overflow check; screenshot inspection                               |
| Existing walkthrough           | 81 passed; two pre-existing 91/CRITICAL versus 78/HIGH drift failures; two expected sign-in 401 diagnostics; zero layout issues                                                                                     |

Final workspace tests: **565 passed** (shared 1, AI 82, database 18, GitHub 81,
static analysis 11, patch-core 23, RAG 29, executor 10, broker 12, API 298).
Added tests: **60** (content/contracts 22, service lifecycle 31, queue 5, broker
attestation 1, additive migration 1). Unit fakes do not prove PostgreSQL locking;
the eight-request real API proof provides that separate evidence. Negative finalization
and expired-orphan tests cover supersession, membership loss, duplicate delivery,
manifest/deployment tampering, late cancellation and no retry; destructive host crash
recovery is not claimed.

Prisma validate/generate, sequential workspace typecheck, production package/API/
worker/web builds, API/web/broker/executor image builds and diff checks passed.
Tracked formatting stays 143 before / 143 after, with no new failures; canonical
format glob also sees ignored local proof material and is not a tracked-debt measure.
No Python changes; Ruff debt unchanged. Scoped new-local-secret checks found no values
in proposed files or checked isolated service logs; this is not universal non-leakage.

Final local image identities:

- API/worker: `sha256:06c7a2c68b4c7ea49f4ec7a4f85d28d65cbb8c7ff9a128e706e609a1c042c4c9`
- Web: `sha256:e0623f83d86288e4bf5e710f6185a472d3fd68e364210ea2a09e3782cef40c86`
- Broker: `sha256:90d749fca0e014e6fcbe11ef1bb48125c18c9d9cdb6eb8240d165315df238f07`
- Executor: `sha256:1f614d36aae23808a92f72dc0e8c8fd2086be15b5f348f01914fca12a56628b5`

## Adversarial Corrections and Limitations

Review bounded Redis enqueue and dependency reads, consumed late settlement, made
failure cleanup independent of subsequent eligibility rejection, authenticated the
actual deployment, tested finalization rejection and kept cancellation terminal.
The initial isolated internal-only network did not publish the browser API port;
only the ignored new-project configuration gained an ingress network. Its adapter
mount was narrowed to the transport directory; API has no broker-key/control mount.

Broker and Docker daemon remain trusted computing base. No secure erasure, real-time
cleanup guarantee, compromised-kernel resistance, universal secret non-leakage,
exactly-once execution/side effects, semantic patch correctness or exhaustive
accessibility is claimed. Retained jobs and immutable history need a separate
retention/deletion design. Original formatting/Ruff debt, sign-in diagnostics,
clipping observations and walkthrough risk drift remain untouched.

Phase 3C deterministic verification: PASSED. Real Gemini investigation/tool/evidence:
PARTIALLY VERIFIED. Real final grounded response/citations: NOT VERIFIED. Real
multi-turn: NOT VERIFIED. Phase 3D real-provider PROPOSE_PATCH: NOT VERIFIED.
Phase 3E real-provider requirement: NONE; no provider call made. Applied-code
validation / Phase 3F: NOT IMPLEMENTED. Repository/GitHub mutation: NONE.

## Exact Proposed Inventory

37 files; proof drivers, local Compose/environment/secrets, screenshots and generated
reports are ignored and excluded from production build contexts and this inventory.

```text
apps/api/Dockerfile
apps/api/package.json
apps/api/src/collaboration/collaboration.module.ts
apps/api/src/collaboration/patch-application-content.test.ts
apps/api/src/collaboration/patch-application-content.ts
apps/api/src/collaboration/patch-application-deadline.ts
apps/api/src/collaboration/patch-application.controller.ts
apps/api/src/collaboration/patch-application.service.test.ts
apps/api/src/collaboration/patch-application.service.ts
apps/api/src/config/app-config.service.ts
apps/api/src/config/env.schema.ts
apps/api/src/queues/application-shutdown.ts
apps/api/src/queues/patch-application.queue.test.ts
apps/api/src/queues/patch-application.queue.ts
apps/api/src/queues/processors/patch-application.processor.ts
apps/api/src/queues/queues.module.ts
apps/api/src/queues/workers.module.ts
apps/sandbox-broker/src/client.ts
apps/sandbox-broker/src/main.ts
apps/sandbox-broker/src/proof.test.ts
apps/sandbox-broker/src/protocol.ts
apps/web/src/components/workspace/patch-application-panel.tsx
apps/web/src/components/workspace/patch-proposal-card.tsx
apps/web/src/lib/api.ts
apps/web/test/patch-applications.mjs
docs/phase3e-application.md
docs/verification.md
infra/sandbox/compose.application.yml
package.json
packages/database/package.json
packages/database/prisma/migrations/20261003030000_patch_applications/migration.sql
packages/database/prisma/schema.prisma
packages/database/src/client.ts
packages/database/test/application-migration.test.ts
packages/shared/src/contracts/index.ts
packages/shared/src/contracts/patch-application.ts
pnpm-lock.yaml
```

Proposed commit: `feat(collaboration): materialize accepted patches in restricted isolation`.
Stop before commit/push; Phase 3F has not started.
