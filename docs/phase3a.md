# Phase 3A: Conversation Foundation

Starting revision: `1111467d65f65ceff6e8090559786a857122667b`.
Verification date: 2026-10-02. Implementation remains uncommitted pending approval.

## Scope and Persistence

The additive `20261002000000_conversation_foundation` migration adds
`Conversation`, `CollaborationTurn`, and `ConversationMessage`, their indexes,
compound tenant/parent foreign keys, request uniqueness, and content/sequence checks.
Two existing parent tables receive compound unique indexes. No existing data is
rewritten. There is no `ReviewSession` table, archive operation, AI execution,
tool/evidence table, proposal, sandbox, or provider prompt.

Only `OPEN` conversations, `RECORDED` turns, and `HUMAN` messages exist in this
stage. Each message, turn, sequence increment, and safe audit event is one
transaction. Collaboration audit failure rolls back the mutation; the existing
best-effort audit subsystem is otherwise unchanged. Audit metadata excludes titles
and message bodies.

`0_baseline` remains byte-identical with SHA256
`e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.
Legacy-baseline eligibility is unchanged. Applied migrations must remain immutable.
API startup checks table readiness and performs no schema mutation.

## API and Authorization

- `POST /api/v1/review-sessions/:prId/conversations`
- `GET /api/v1/review-sessions/:prId/conversations`
- `GET /api/v1/conversations/:id`
- `POST /api/v1/conversations/:id/messages`

JWT-derived actor/organization, current membership, and the organization ->
repository -> PR chain establish authorization. Existing developer-role policy
applies. Unknown and foreign conversations are scoped 404s; public shares grant
no conversation access. Strict schemas reject client actor, organization, role,
and arbitrary ReviewRun fields.

Creation accepts a UUID request ID, a title of 1-160 characters, and an optional
validated PR/finding/file/range/comment anchor. Message content is 1-8000 characters.
Anchors are contextual metadata, not trusted evidence; ranges are bounded to
200 lines and paths must belong to the authorized PR's changed files.
Lists and history use cursor pagination, default 20 and maximum 50 rows.

Request IDs are scoped to the actor and PR/conversation. Normalized-payload hashes
make compatible replays return the same logical result and incompatible reuse
return 409. PR then conversation row locks serialize mutations; explicit unique
sequences preserve committed order rather than relying on timestamps. Concurrent
request arrival order is not promised. Successful replay does not require another
upstream head lookup.

New messages obtain the initiating user's authenticated GitHub PR head outside
database locks, then require the local PR head to match inside the transaction.
Unavailable head lookup returns 503, stale local state returns 409, and neither
persists a message. A matching ReviewRun is server-selected when available.
The pinned SHA is the observed upstream revision, not a guarantee that GitHub
cannot advance again between observation and commit.

## UI

The existing private review workspace gains a small Collaborate panel: create,
list, select, contextual origin, paginated history, save human messages, and clear
loading/error/retry states. Persisted history survives reload; selection must be
reopened after reload. Text is rendered as text, not trusted HTML. No fake AI reply
or typing state exists. AI execution is explicitly unavailable.

## Verification

- Prisma validation/generation, sequential typechecks, workspace production builds,
  and isolated API/web Docker builds passed.
- Workspace tests: 176 passed (API 96, database 9, RAG 29, AI 23, GitHub 7,
  static analysis 11, shared 1). API includes 35 collaboration tests.
- Real PostgreSQL proof: eight concurrent creation requests -> one conversation;
  eight duplicate messages -> one message; eight distinct messages -> sequences
  2-9. Replay conflicts, pagination, cross-tenant service/foreign-key denial,
  nested PR anchors, and audit-failure rollback were exercised.
- Focused real API/browser proof: 49 assertions passed, including two human
  messages, reload, tenant denial, literal script-text rendering, unavailable/stale
  head errors, safe public sharing, narrow viewport, and unchanged existing
  review/comment/gate/metric/risk state during collaboration operations.
- API/PostgreSQL restart: all 32 application-table hashes unchanged; subsequent
  API/browser readback retained exact message IDs, order, and pinned heads.
- Fresh migrations applied baseline plus the forward migration. An additional
  unseeded proof database retained zero rows in relevant application tables.
  A separate baseline-managed seeded database applied only the forward migration;
  all 29 baseline application-table hashes survived unchanged. Repeated db-init
  completed with no pending migrations on both databases.
- Existing browser walkthrough: 81 checks passed, two failed. The unchanged test
  expects risk `91/CRITICAL`, but the unchanged seed supplies `78/HIGH`.
  Comments, verdicts, gates, sharing/revocation, activity, and responsive checks
  passed. Two expected signin 401 console entries remain disclosed; no layout
  issues were reported in this run. These stale assertions were not weakened.
- Scoped formatting checks pass except the existing review-page formatting debt,
  which also fails at the starting revision. Only the new migration test was
  formatted at final review; no repository-wide formatting was performed.
- `git diff --check` passed. Python/ML source was untouched; no new Python
  regression or Ruff certification is claimed.

Adversarial review corrected a departed-member information distinction by checking
membership before conversation lookup. Tests cover known and guessed IDs. No
remaining scoped IDOR, ordering/idempotency race, fake-AI, or share privilege
escalation was identified. This is focused verification, not penetration testing.

## Final Blocker Classification

**B. PRE-EXISTING TEST/SEED DRIFT.** No Phase 3A regression or variable ML
inference caused the two walkthrough failures.

- At certified revision `1111467d65f65ceff6e8090559786a857122667b`, walkthrough
  lines 266 and 341 already require a table `CRITICAL` badge and score `91`.
  Git blame attributes both assertions to `f8d59cb`, before Phase 3A.
- The same baseline seed explicitly inserts PR #412's `latestRiskScore: 78`,
  `latestRiskLevel: HIGH`, completed ReviewRun, and MlPrediction `78/HIGH` with
  model `xgboost/bootstrap-v1`. Git blame attributes the prediction values to
  initial commit `d70eb63`. The seed does not invoke an ML model to obtain them.
  Its seeded tool output and audit summary also say `78/HIGH`; seeded static
  finding severity is a separate field, not the PR's ML risk level.
- Git comparisons show no Phase 3A change to the walkthrough, seed/PR patches,
  ML feature extraction or invocation, analysis report, review-session readback,
  PR risk mapping, RiskPanel, or risk badge/meter. The private review page adds
  only the conversation import/panel; its risk rendering expressions are intact.
  Seed bytes match the baseline archive. Walkthrough text matches after Git
  line-ending normalization.
- A Git archive of that exact revision supplied separately built baseline API/web
  images. New project `codelens_phase3a_baseline_20261002`, new volume
  `codelens_phase3a_baseline_20261002_postgres_data`, and baseline-only migration
  initialized a fresh database before explicit seeding. SQL in baseline and Phase
  3A runtimes returned identical PR/run/prediction values: `78/HIGH`, COMPLETED,
  `hadMlRisk=true`, `xgboost/bootstrap-v1`, `isBaseline=true`.
- The unchanged walkthrough ran against those exact-baseline images and reproduced
  **81 passes and the same two failures**, two signin 401 console entries, and no
  layout issues. Its stale hard-coded oracle is the root cause, not nondeterministic
  model execution. Assertions and seed values remain untouched.

Baseline reproduction used only new resources. Web port 53500 was initially
blocked by Windows' reserved 53498-53597 range; the ignored isolation configuration
was changed to web 53401 (API 54500, PostgreSQL 55533). This port issue did not
change risk inputs. Generated baseline reports/archive/checkout remain local.
This pass adds no production changes and does not upgrade any other certification
claim. Phase 3A may proceed to a scoped commit despite the disclosed baseline drift.

## Isolated Runtime and Evidence Boundaries

Implementation verification mutated only project `codelens_phase3a_20261002`;
the final classification pass additionally created the separate baseline project
described above. The implementation project's volumes are
`codelens_phase3a_20261002_postgres_data`,
`codelens_phase3a_20261002_managed_postgres_data`,
`codelens_phase3a_20261002_redis_data`, and
`codelens_phase3a_20261002_ml_org_models`.
Loopback ports: web 53400, API 54400, fresh PostgreSQL 55433, managed PostgreSQL 55434. Redis and ML have no published host ports.

The positive message runtime proof uses an explicitly mounted test-only GitHub
head boundary. Before that override, the normal credential-free API returned 503
and persisted no message. This does not establish new real GitHub integration
evidence. No OAuth, Gemini, or OpenAI calls were made; no original/C2 resources or
fixture repositories were modified. Image-build dependency downloads are separate
from these integration calls.

Runtime drivers live under excluded test directories; actual final API/web images
were checked to contain neither test directories nor local isolation artifacts.
The isolated API remains in explicitly overridden proof mode, not a production
deployment. Ignored local Compose files and runtime evidence must not be committed.

Re-run the existing focused browser driver only after preparing an isolated seeded
runtime and its synthetic head boundary; it requires explicit `WEB_URL`, `API_URL`,
`DEMO_PASSWORD`, and `PHASE3A_EVIDENCE_DIR`. Never redirect it to original/C2 data.

## Proposed File Inventory

Existing files changed:

- `.dockerignore`
- `apps/api/src/app.module.ts`
- `apps/web/Dockerfile`
- `apps/web/package.json`
- `apps/web/src/app/(app)/reviews/[id]/page.tsx`
- `apps/web/src/lib/api.ts`
- `packages/database/package.json`
- `packages/database/prisma/schema.prisma`
- `packages/database/src/client.ts`
- `packages/shared/src/contracts/index.ts`
- `pnpm-lock.yaml`

New files:

- `apps/api/src/collaboration/collaboration.controller.ts`
- `apps/api/src/collaboration/collaboration.module.ts`
- `apps/api/src/collaboration/collaboration.service.ts`
- `apps/api/src/collaboration/collaboration.service.test.ts`
- `apps/web/src/components/workspace/conversation-panel.tsx`
- `packages/database/prisma/migrations/20261002000000_conversation_foundation/migration.sql`
- `packages/database/test/conversation-migration.test.ts`
- `packages/shared/src/contracts/conversation.ts`
- `docs/phase3a.md`

The proposed commit inventory is **20 files: 11 modified and 9 new**. Per the
final pre-commit instruction, the three local proof drivers are excluded:
`apps/api/test/collaboration-runtime-preload.cjs`,
`apps/api/test/collaboration-runtime.cjs`, and
`apps/web/test/conversation-foundation.mjs`. They remain untracked local files,
not production features or proposed commit contents. Unit/migration tests above
remain included; generated evidence does not.

Local ignored files include `.compose.phase3a.local.yml`,
`.compose.phase3a-proof.local.yml`, `.compose.phase3a-baseline.local.yml`,
`.codelens-tmp/**`,
`apps/web/test/screenshots/**`, and generated build outputs. None belong in the
proposed commit.
