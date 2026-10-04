# Paired original/patched validation

Phase 3F proper adds persisted, bounded deterministic observations for an
accepted immutable proposal whose application is APPLIED/DISPOSED. It does not
add static-analysis reruns, ML reassessment, candidate RAG indexing or AI
re-review. Passing these checks does not establish that the proposal is safe.

## Domain and trust

`20261004000000_validation_runs` adds ValidationRun, ValidationAttempt and
ValidationStep. Earlier migrations and the lock are unchanged. The run binds
tenant, repository, PR, conversation, turn, proposal revision/digest, application,
pinned HEAD, original snapshot, candidate manifest and deployment identities.
Creation and last-update timestamps accompany deadline/completion timestamps.
Database guards protect identity, immutable observations and terminal history.

Creation requires current DEVELOPER-or-higher membership, an accepted proposal
and a consistent APPLIED/DISPOSED application. Client scope is never authoritative.
Foreign resources are scoped 404s; anonymous requests are denied. Changing the
current PR HEAD makes historical observations stale, not rewritten or rebased.

Actor-scoped UUID/hash identity and transactional advisory/application locks make
identical replay reuse a run and conflicting reuse fail. A partial unique index
prevents simultaneous active or cleanup-uncertain runs for an application.
This is not an exactly-once execution guarantee.

The identifier-only `paired-validation` queue has one execution attempt, a
deterministic job ID and dedicated-worker concurrency one. PostgreSQL owns state;
Redis/BullMQ transports identifiers. A random attempt fence, current membership,
immutable bindings, cancellation and a 12-minute run deadline are checked before
launches and final writes. API processes never execute queue jobs.

ORIGINAL is the pinned PR HEAD, **not PR base**. The worker independently reads
that exact snapshot twice, verifies both against the stored snapshot, reconstructs
the immutable proposal in memory and checks every candidate manifest entry/digest
against the APPLIED application. No retained application filesystem is used.

For each selected fixed profile, ORIGINAL and PATCHED use independent fresh
input volumes/executors, sequentially. The certified broker remains authoritative
for compatibility, image, launcher, mounts, resources, no-network policy and
cleanup. There is no dependency installation or arbitrary configuration fallback.

## Results and comparison

Run states: QUEUED, PREPARING, RUNNING, COMPLETED, FAILED, CANCELLED.
Outcomes are separate: BOTH_PASS, ORIGINAL_PASS_PATCHED_FAIL,
ORIGINAL_FAIL_PATCHED_PASS, BOTH_FAIL, UNSUPPORTED, INCONCLUSIVE.
A legitimate failing check can be a COMPLETED observation, not an infrastructure
failure. Each profile retains its own comparison; conflicting profile directions
produce aggregate INCONCLUSIVE rather than inventing an overall improvement.

Steps bind profile/version, side, normalized input digest, authenticated nonce and
result digest. Broker-observed start/exit/termination, OOM, duration, cleanup and
bounded streams are separate from runner-reported counts/report digest.
Runner reports always remain `trusted: false`. Empty, missing, malformed,
wrong-kind, timeout, resource-terminated or inconsistent reports cannot establish
PASS. Tests can manipulate their own results; comparisons do not prove causality.

The broker bounds capture to 1 MiB per stream and excerpts to 8 KiB. Product
validation rechecks bounds and binding, reapplies sanitization, and stores the
SHA-256 of the normalized sanitized result. Stream digests identify the captured
bytes/prefix, not sanitized display text; `complete` discloses capture scope.
The result digest is not represented as the original response HMAC.

Metadata-only audits cover request, queue, attempt, sides, completion/failure,
cancellation and cleanup uncertainty. Source, patch, output, raw fences, HMACs,
credentials and chain-of-thought are not audit metadata. React renders excerpts
as escaped bounded text, never terminal HTML.

## Cancellation and recovery limits

Cancellation terminally fences writes, preserves completed observations and stops
future launches. The worker monitor aborts the owned authenticated socket, which
is the foundation broker's cancellation signal. It does not fabricate a signed
cleanup receipt after the connection is gone. Active cancellation therefore stays
cleanup UNCERTAIN even when operator runtime inspection confirms disposal.

UNCERTAIN blocks any new validation for that application. This slice has no
automatic uncertainty-clear endpoint, no automatic retry, no blind hostile-code
reexecution and no claim of immediate cleanup acknowledgment. Cancellation before
launch can truthfully remain NOT_STARTED. Cancel replay is idempotent.

Reconciliation re-enqueues missing QUEUED jobs with their existing identity and
terminally expires overdue claimed runs without replaying execution. A worker
crash or lost broker acknowledgment remains conservative until deadline; it is
not universal crash recovery or exactly-once behavior. Broker resource recovery
uses the unchanged foundation ownership journal. Run and broker budgets are
distinct; the run deadline never increases the per-execution foundation limits.

One simultaneous all-services restart interrupted Redis during worker shutdown.
The existing 180-second drain deadline expired and logged `drained=false
cleaned=false`; Docker restarted the worker and persisted observations remained
unchanged. This proves restart persistence, not graceful draining through
dependency loss. No active-job recovery or new shutdown guarantee is inferred.

## API and deployment

- POST/GET `/api/v1/patch-applications/:id/validations`
- GET `/api/v1/validations/:id`
- GET `/api/v1/validations/:id/steps`
- POST `/api/v1/validations/:id/cancel`

Creation contains only a request UUID and fixed profile IDs; cancellation only a
UUID. Strict validation rejects commands, images, arguments, environment,
network, mounts, ownership and resource overrides. The UI requests both profiles
and exposes no arbitrary execution configuration.

Run db-init before API/worker startup. Both only verify schema readiness. Opt-in
operators configure `CODELENS_VALIDATION_IMAGE` as an immutable sha256 image,
`CODELENS_VALIDATION_BUNDLE_DIGEST` and
`CODELENS_VALIDATION_CONFIGURATION_DIGEST` from the certified image labels.
Missing configuration refuses creation; it does not provision a daemon.

Mount only the validation control volume at `/validation-control:ro` and the
separate 32-byte secret at `/run/secrets/validation-key` into the dedicated worker.
The broker mounts its control volume at `/control` and the same separate secret;
only the broker receives Docker authority. Do not mount either into executors or
mount a Docker socket into API/workers. Follow the unchanged
[foundation deployment and security limits](validation-foundation.md).

## Evidence and boundaries

The isolated project is `codelens_phase3f_validation_20261004`, web/API ports
53406/55406. Its new PostgreSQL/Redis/control/journal volumes do not reuse older
CodeLens resources. Deterministic Git-object responses are mounted through an
ignored operator preload; exact Git snapshot/proposal/application paths remain
real, and external transport is explicitly blocked. No provider is involved.

Runtime evidence covers migration upgrade/fresh initialization, prior-table
fingerprints, actual API/BullMQ/worker/authenticated broker delivery, independent
paired sandboxes, all four pass/fail combinations, unsupported dependencies,
active cancellation/late-write fencing, tenant denial, concurrent replay,
sanitized persisted observations, safe audits, stale readback and restart.
Browser proof uses `apps/web/test/validations.mjs` with explicit isolated WEB_URL,
VALIDATION_PROJECT, VALIDATION_FIXTURES, VALIDATION_OUTPUT and DEMO_PASSWORD.
Proof drivers, local keys/configuration, screenshots and generated readback stay
ignored and excluded from production image contexts.

This is scoped local Docker proof, not hostile multi-tenant production safety,
container-escape certification, gVisor/VM verification or proof that tests/patches
are trustworthy. Real-provider proposal behavior is unchanged and not verified.
Known 91/CRITICAL versus 78/HIGH walkthrough drift, sign-in diagnostics and
existing formatting/Ruff debt are not repaired by this slice.

## Freeze report

The scoped implementation is ready for review, **not committed or pushed**.
Proposed subject: `feat(collaboration): persist paired isolated validation runs`.
The paired deterministic slice's exit criteria are satisfied within the explicit
local-proof and cleanup-uncertainty boundaries above; later re-review slices are
not started. This is not an exact-SHA hosted-CI certification.

Verification: 743 workspace tests passed with seven Windows skips; Linux broker
13/13 and executor 32/32 separately passed, covering those skips. Focused domain/
queue tests passed 40/40, authenticated-channel tests 4/4, migration tests 19/19
including the new additive invariant. Browser validation proof passed 11 checks
on desktop and a 390px viewport. Prisma validation/generation, sequential workspace
typecheck, production builds and Docker builds passed. `git diff --check` passed.
Changed-file formatting comparison introduced no new failures; the three already
failing touched files remain disclosed, with unrelated formatting/Ruff debt intact.

Final isolated upgrade preserves every previous public application's table
fingerprint. All three validation tables are empty before explicit validation
requests. The separate empty database applies eight migrations with all 44
application tables empty. Restart preserves full run/attempt/step readback.
Six concurrent identical requests reuse one run; conflicting reuse is rejected.
Runtime policy inspection checked 23 independent execution sandboxes and confirmed
owned-resource disposal. Original fixture snapshot digests/pins are unchanged;
there is no Git worktree/index in validation execution and external transport is
blocked. Existing container identities remain unchanged.

Adversarial corrections include committing infrastructure observations before
terminal failure (rather than rolling back the observation), rechecking current
membership/bindings at result persistence, recording post-transition audit state,
and adding the run-level last-update timestamp. Test checks do not infer a cleanup
receipt from teardown. No arbitrary command surface, new broker policy, provider
call, GitHub mutation or static/ML/RAG/AI re-review was introduced.

All seven prior migration files and the lock are byte-identical to foundation
HEAD `4d785a9e0266917f6bd92226a9cfcb9315ea1dd4`. Baseline SHA-256:
`e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.
Scoped scans found zero newly generated credential-value matches in proposed
files or checked isolated stdout/stderr logs, and zero supplied synthetic markers
in checked service logs. This is not universal secret non-leakage certification.

### Exact proposed inventory: 33 files

```text
apps/api/Dockerfile
apps/api/package.json
apps/api/src/collaboration/collaboration.module.ts
apps/api/src/collaboration/validation-content.test.ts
apps/api/src/collaboration/validation-content.ts
apps/api/src/collaboration/validation.controller.ts
apps/api/src/collaboration/validation.service.test.ts
apps/api/src/collaboration/validation.service.ts
apps/api/src/config/app-config.service.ts
apps/api/src/config/env.schema.ts
apps/api/src/queues/application-shutdown.ts
apps/api/src/queues/processors/validation.processor.ts
apps/api/src/queues/queues.module.ts
apps/api/src/queues/validation.queue.test.ts
apps/api/src/queues/validation.queue.ts
apps/api/src/queues/workers.module.ts
apps/validation-broker/src/client.test.ts
apps/validation-broker/src/client.ts
apps/web/src/components/workspace/patch-application-panel.tsx
apps/web/src/components/workspace/validation-panel.tsx
apps/web/src/lib/api.ts
apps/web/test/validations.mjs
docs/paired-validation.md
docs/validation-foundation.md
docs/verification.md
packages/database/package.json
packages/database/prisma/migrations/20261004000000_validation_runs/migration.sql
packages/database/prisma/schema.prisma
packages/database/src/client.ts
packages/database/test/validation-migration.test.ts
packages/shared/src/contracts/index.ts
packages/shared/src/contracts/validation.ts
pnpm-lock.yaml
```

Excluded local proof material is contained in
`.codelens-tmp/phase3f-validation/`: setup/Compose/preload/API/database/security/
audit/freeze drivers, extracted foundation sources, generated local environment
and keys, result JSON and browser screenshots. Existing local artifacts elsewhere
remain ignored and untouched. Docker context excludes `.codelens-tmp`, local env/
Compose files and `apps/web/test`; no runtime driver is imported by product code.
