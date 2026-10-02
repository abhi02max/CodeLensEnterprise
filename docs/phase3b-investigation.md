# Phase 3B: Investigation and Evidence Foundation

Starting revision: `0dda49b2af9f16aa735aae709e2e6b79b66a4aae`. This document records
the uncommitted Phase 3B implementation and its isolated verification, not a
release certification or a Phase 3C collaborator.

## Domain and Ownership

`CollaborationToolCall` belongs to an existing human `CollaborationTurn`. It
records the actor, server-bound organization/PR/repository, tool version,
sequence, UUID request identity, normalized input digest, reservation fence,
deadline, status, bounded diagnostics and correlation ID. It does not create an
analysis `ReviewRun` or an analysis `ToolRun`.

`EvidenceReference` belongs to that call and turn through a tenant-scoped compound
foreign key. It stores an immutable API snapshot: source identity, provenance,
revision where known, range, hashes, bounded redacted excerpt, method and metadata.
There is no evidence update endpoint. Database administrators remain able to
modify database rows; this is not a tamper-proof ledger.

The additive migration `20261002010000_investigation_foundation` creates two
tables, their indexes/checks, and two parent compound unique indexes. Existing
rows are not rewritten. Baseline and applied 3A migration bytes are unchanged.
Legacy-baseline compatibility detection does not require 3B tables. Initialization
uses checked-in migrations; runtime module initialization only checks readiness.

## Bound Scope and API

Authentication and current database membership bind actor -> conversation ->
turn -> PR -> repository -> organization. Tool scope and the turn's head SHA come
from the server, not request input. The existing DEVELOPER-or-higher role policy
applies; REVIEWER, ADMIN and OWNER are higher roles. Membership is rechecked at
reservation and finalization. Foreign/forged resource references return scoped
404s. Input cannot override organization, repository, PR or credential scope.
GitHub file reads use the requesting user's existing connection, not an arbitrary
organization token.

Endpoints under `/api/v1`:

- `POST /collaboration-turns/:turnId/tools/:tool`: strict `{ requestId, input }`;
  UUID request ID, typed nine-tool allowlist, strict per-tool input schema.
- `GET /collaboration-tools/:id`: bounded persisted call and evidence.
- `GET /evidence-references/:id`: immutable observation readback.
- `GET /collaboration-turns/:turnId/evidence`: summaries, default 10/max 25 calls,
  `afterSequence` pagination; no unbounded conversation evidence aggregation.

Successful POST responses use the existing Nest 201 convention. Failure results
may be persisted as `UNAVAILABLE`, `TIMEOUT`, `CANCELLED` or `LIMITED`; they are not
empty successes. Missing/foreign selected contexts return 404 externally while
retaining the authorized caller's bounded failure record. Invalid input is 422;
conflicting replay or exhausted reservation budgets are 409.

## Tools and Provenance

| Tool                       | Source and Limits                                                                          | Claim                                             |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `read_pr_diff`             | Cached imported patches; 3 files/page, 16 KiB/excerpt                                      | SNAPSHOT, import coverage PARTIAL                 |
| `list_changed_files`       | Cached changed files; 50/page                                                              | SNAPSHOT, import coverage PARTIAL                 |
| `read_file_range`          | Exact 40-hex commit, <=1 MiB text file, <=200 lines/16 KiB                                 | EXACT_REVISION after Git blob hash verification   |
| `search_repository`        | Literal scan, 20 files/page, <=500-file window, one match/file                             | Exact matching file observations; overall PARTIAL |
| `retrieve_context`         | Existing hybrid/MMR engine, topK <=8, ~4,000-token/16,000-byte budget                      | INDEXED_CONTEXT; per-chunk revision unknown       |
| `read_analysis_evidence`   | Existing static findings, AI JSON findings, ML prediction/numeric features, report summary | DERIVED; no new analysis/model invocation         |
| `read_review_thread`       | Root/direct replies, 5 entries/page, 8 KiB envelope, 256-byte excerpts                     | Mutable COMMENT_SNAPSHOT, PARTIAL                 |
| `inspect_tests`            | Heuristic test paths and literal exact-file search                                         | Candidates only; tests are not executed           |
| `read_repository_metadata` | Safe persisted metadata/index hint                                                         | SNAPSHOT; no credential/error payload             |

`search_symbols` is deferred: there is no reliable LSP/definition index or
caller/callee graph to expose. The implementation does not manufacture one.

Historical HEAD file reads use the immutable turn SHA even after the PR advances.
BASE is supported only while the current cached PR head matches the turn; a
historical base is not stored on the turn. Cached diff/files use a short
repeatable-read transaction, reject a different cached head, and remain snapshots
rather than independently verified GitHub patches. Import completeness is not
assumed. Search never turns missing matches, truncated trees or skipped files
into a repository-wide absence claim.

File evidence carries SHA-256 of full decoded file bytes, Git blob SHA-1 and a
selected-payload hash. Redaction/truncation flags distinguish displayed text from
original hashed bytes. AI findings use whole-array payload hash plus finding
index and AI-review ID: changed JSON cannot silently reuse an old identity.
Validated AI path/line fields are retained as derived anchors, not source proof.
Comments retain captured content/hash after the source is edited.

3B deliberately performs provider-free lexical/graph/convention retrieval with
MMR. No query embedding provider is invoked. Unknown per-chunk revision is never
upgraded using a repository-level index SHA; that SHA is metadata only. Storage
read failures are tracked at the investigation boundary, including errors swallowed
by the shared fallback store, and produce UNAVAILABLE rather than false no-match
evidence. This does not validate semantic retrieval quality.

All repository, comment, test, AI and retrieved text is `UNTRUSTED_DATA`.
Rendering is literal React text, not HTML or instructions. Source text cannot
alter policy, select credentials or authorize another scope. Pattern redaction
uses existing shared rules; universal secret detection is not claimed.

## Reservation and Failure Semantics

A turn row lock serializes reservation. Same actor/request/tool/normalized input
replays one logical call; conflicting request reuse is rejected. Calls have
unique sequences 1..8; at most two active reservations per turn. Source work runs
outside database transactions. A fenced final transaction commits terminal
status, evidence and audit together, or rolls all of them back.

Default tool deadline is 20 seconds. GitHub receives an abort signal and a bounded
HTTP timeout; late source results cannot finalize an expired/cancelled fence.
Interrupted reservations expire lazily on execution/call read and become
CANCELLED with outcome-unknown wording. They are not automatically re-executed.
There is no background expiry sweeper, explicit cancellation API or agent loop.
Prisma reads are not physically cancelled by the logical tool timer; limits
bound logical active calls, not a guarantee of instantaneous SQL cancellation or
a deployment-wide cap across different turns. Input/query bodies and source
excerpts never enter tool audit metadata (only turn ID/tool).

## Frontend

Conversation context choices cover PR, risk discussion, static finding, AI
finding and comment thread. Four contextual evidence actions replace a generic
RPC/tool console. The evidence history and detail display status, provenance,
source/range, revision, hashes, method, coverage, redaction and truncation. AI
does not choose or execute these tools. The viewer applies to the last message
on the visible bounded conversation page; older pages and API turn reads remain
available. Risk discussion remains PR context metadata until actual ML evidence
is requested.

## Verified Evidence

Isolated project: `codelens_phase3b_20261002`. New volumes:
`codelens_phase3b_20261002_postgres_data` and
`codelens_phase3b_20261002_managed_postgres_data`. Ports: web 53402, API 54402,
fresh PostgreSQL 55435, managed PostgreSQL 55436 (loopback); Redis/ML have no host
ports. No original, Phase 3A or C2 container/volume was modified. A previously
built ML image was reused as an image only, not as an existing container/volume.
Final API runtime image: `codelens-phase3b-api:local`, identity
`sha256:426624a404b8c0e932722e82b8e3c007c7e9effff0f545fc624ff4414982aaed`.

- Fresh initialization applied baseline -> 3A -> 3B and verified RAG schema.
  All 34 application tables were empty before explicit demo initialization.
- Managed baseline -> 3A, explicit seed and existing conversation were created
  before 3B. Upgrade preserved hashes of all 32 existing tables; new tables empty.
- Repeated initialization: managed state, no pending migrations, RAG ready.
- Restart: all 34 application table counts/hashes unchanged.
- Real PostgreSQL reservation: eight identical consumers -> one call; conflicting
  replay rejected; distinct sequences 1..8; ninth call rejected; two active
  reservations accepted and third rejected.
- Exact deterministic file: SHA-256
  `3f26971eb6ddd75bdb3713583baada5049b060726cccf8d0ac479e0fc30a64d4`,
  Git blob `aa92a3032b4271a01122b1bd60909c8da242773b`; historical HEAD retained,
  stale cached diff/BASE rejected; two search matches/one test candidate.
- Persisted analysis: four static findings, five AI findings, ML 78/HIGH plus
  numeric features, report snapshot. Three RAG contexts (LEXICAL/CONVENTION)
  retain unknown revision and provider-free degradation.
- Mutable comment snapshot remained unchanged after editing its isolated source.
  Foreign turn/call/evidence and cross-tenant nested foreign keys were denied.
- Expired reservation stayed CANCELLED after late success. Injected final audit
  failure rolled back both terminal status and evidence. Real 20-second timeout
  recorded TIMEOUT with zero evidence (observed 20,021 ms). RAG storage outage
  recorded UNAVAILABLE, not empty success.
- API/browser: 13 checks passed, including contextual options, auth/scope/input
  denial, stored evidence reload, literal `<script>` rendering, desktop/mobile
  inspection and no unhandled browser exceptions. This is not WCAG certification.
- Workspace suites passed: shared 1, static 11, AI-agent 23, database 12, GitHub
  13, RAG 29, API 143 (232 total); 47 API investigation tests and six exact-file
  client tests are included. Prisma validation/generation, sequential typecheck,
  production packages/API/web builds and `git diff --check` passed.
- Prettier comparison of Git-normalized tracked content: starting HEAD 143
  failures, proposed content 143, no new failures. Existing debt was not repaired.
  A production build regenerated `next-env.d.ts` with CRLF locally; this adds a
  raw-working-file formatting warning but no Git content change. New files pass
  scoped formatting. No Python files or Ruff configuration changed.
- Existing walkthrough: 81 passes/two known stale risk assertions failed
  (91/CRITICAL versus unchanged seed 78/HIGH). Two expected sign-in 401 console
  messages remained; layout audit found no issues. The assertions/seed were not
  changed. Review/comment/verdict/share/audit workflows otherwise passed.

Exact-revision GitHub reads used an explicitly mounted deterministic test-only
boundary, not real GitHub credentials. The API image without mounts contains
none of `.codelens-tmp`, local Compose files or runtime/browser driver folders.
No Gemini/OpenAI calls, real GitHub reads/mutations, patch generation, sandbox
execution or Phase 3C orchestration occurred. Seed/tool proof did not fabricate
analysis runs. The seeded PR has a 38-character legacy SHA; exact-file proof used
a separate isolated PR with full synthetic commit identities instead of altering
that fixture.

## Verification Commands and Local Artifacts

Commands used (pnpm verification bypass avoids local dependency reinstallation):

```powershell
pnpm --config.verify-deps-before-run=false test
pnpm --config.verify-deps-before-run=false -r --workspace-concurrency=1 --if-present typecheck
pnpm --config.verify-deps-before-run=false build
git diff --check
```

The focused browser/API test is `apps/web/test/investigation-foundation.mjs`.
Supply explicit isolated WEB_URL/API_URL, DEMO_PASSWORD and INVESTIGATION_FIXTURE
manifest plus an ignored INVESTIGATION_OUTPUT directory. The fixture manifest
contains PR/turn/conversation/call/evidence IDs and an isolated second-tenant
email, never tokens or provider credentials. It must describe an explicitly
prepared deterministic test environment; it is not suitable for production data.
The existing walkthrough additionally needs isolated WEB_URL/DEMO_PASSWORD.

Local-only proof resources remain ignored: `.compose.phase3b.local.yml`,
`.compose.phase3b-proof.local.yml`, and `.codelens-tmp/phase3b/` (preload/runtime
drivers, copied immutable pre-3B migrations, fixture manifests, table-hash proof,
screenshots/results). Existing unrelated ignored local artifacts are untouched.
No local credentials/configuration/evidence artifacts belong in the commit.

## Proposed File Inventory

22 proposed files, including this document:

```text
apps/api/src/collaboration/collaboration.module.ts
apps/api/src/collaboration/investigation-support.ts
apps/api/src/collaboration/investigation-tools.service.ts
apps/api/src/collaboration/investigation-tools.service.test.ts
apps/api/src/collaboration/investigation.service.ts
apps/api/src/collaboration/investigation.service.test.ts
apps/api/src/collaboration/investigation.controller.ts
apps/web/src/app/(app)/reviews/[id]/page.tsx
apps/web/src/components/workspace/conversation-panel.tsx
apps/web/src/components/workspace/evidence-viewer.tsx
apps/web/src/lib/api.ts
apps/web/test/investigation-foundation.mjs
packages/database/package.json
packages/database/prisma/schema.prisma
packages/database/prisma/migrations/20261002010000_investigation_foundation/migration.sql
packages/database/src/client.ts
packages/database/test/investigation-migration.test.ts
packages/github/src/client.ts
packages/github/src/file-snapshot.test.ts
packages/shared/src/contracts/index.ts
packages/shared/src/contracts/investigation.ts
docs/phase3b-investigation.md
```

## Review Boundaries

Adversarial fixes made before closure: consistent cached-diff snapshot; fresh
scope at reservation; AI anchor run selection; persisted report/numeric feature
readback; swallowed RAG storage-error distinction; validated AI derived anchors;
strict request identity at service boundary. Truncation/pagination also normalize
successful subset observations to PARTIAL. Unit/API/runtime tests cover the
associated invariants. No known Phase 3B blocker remains within this scope.

Search coverage is limited; comments are clipped snapshots; report output is a
summary rather than a rendered full report; RAG is provider-free and revision
unknown. Expiry is lazy, not a distributed recovery system. Real upstream
historical-file behavior and semantic retrieval quality are unverified by this
phase. Existing formatter/tooling debt and risk walkthrough drift remain
disclosed, not silently fixed. No claim of universal secrecy, exactly-once
processing or exhaustive security/accessibility coverage is made.

Proposed commit: `feat(collaboration): add bounded investigation and evidence snapshots`.
Stop before commit. Phase 3C has not begun.
