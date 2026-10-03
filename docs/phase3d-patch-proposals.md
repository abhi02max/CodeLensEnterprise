# Phase 3D: Immutable Patch Proposals

Phase 3D stores reviewable change proposals as data. It does not apply patches,
modify repository files, run tests, create commits, push branches or mutate GitHub.
Acceptance approves an immutable proposal for a future application step only.

## Persistent Domain

`20261003020000_patch_proposals` adds `PatchProposal`, `PatchProposalFile` and
`PatchProposalEvidence`, and a nullable server-controlled revision target on a
collaboration turn. Existing rows are not rewritten. Earlier migrations,
including the exact-revision foundation, are unchanged.

A proposal records tenant/repository/PR/conversation/turn, optional originating
attempt, author type/identity, provider/model, pinned base/head, request identity,
revision, parent, digest, counts and timestamps. File rows store source blob and
content hashes, resulting content hash, structured operations and canonical diff.
Normalized evidence relationships reference persisted observations from that turn.
Database triggers reject updates/deletes of proposal content and file/evidence
rows. Only lifecycle/decision metadata changes; supersession preserves earlier
decision metadata. This retention also prevents cascading deletion of parents
with proposals. A future retention workflow must be designed explicitly.

## Exact Edit Representation

Only `MODIFY` is supported. Each file supplies a safe relative path, expected
40-character blob SHA, evidence IDs, and disjoint inclusive 1-based line ranges.
Each range supplies exact expected text (without the range's final newline) and
replacement text. CRLF is not normalized. Replacements apply to original offsets
in reverse order, in memory only. There is no fuzzy matching.

Every file uses the existing exact Git verifier at the turn's pinned HEAD.
Both exact base/head pins must exist. Only verified UTF-8 regular mode `100644`
blobs with `modificationEligible=true` qualify. Expected blob, revision, path and
old text must match. Indexed context and rationale cannot establish these source
preconditions. CREATE/DELETE/RENAME, mode changes, binaries, executables, symlinks
and submodules remain unsupported. NUL and invalid Unicode replacement data fail
closed.

## Canonical Review Representation

Pinned `diff@8.0.2` constructs a server-generated unified diff with three context
lines and no timestamps. Structured patch construction has a 500-line edit-distance
ceiling and a one-second complexity timeout per file. Timeout rejects the proposal,
not a partially generated diff. File/edit/evidence order is normalized before
SHA-256 hashing a versioned representation of pins, intent, files and evidence.
Same normalized input and verified source produce the same digest; a digest is
not a safety, test-success or applicability certificate.

Server limits are 10 files, 500 additions plus deletions total, 64 KiB serialized
normalized intent/canonical payload, 32 operations per file, 8,192 characters per
expected/replacement text, 16 distinct evidence relationships, 300-character
summary, 2,000-character rationale and 1,000-character limitations. No edit is
silently truncated. Generated diff bytes count toward the payload limit.

## Provider Protocol And Finalization

`PROPOSE_PATCH` extends `RESPOND` and `REQUEST_TOOLS`. It carries strict intent
data only, never authoritative scope, commands, acceptance, credentials or an
AI-authored authoritative unified diff. Fabricated evidence is rejected. Existing
3C repair/request/output/context/deadline budgets are unchanged. In particular,
the existing 2,000-byte response guard is stricter than the general 64-KiB proposal
ceiling for provider-originated proposals. Large prior proposal context may fail
the existing 12-KiB context budget rather than expanding it.

Source reads finish outside database transactions. The existing worker attempt
fence, cancellation/deadline checks and turn lock gate one transaction containing
proposal data, supporting citations, truthful assistant text, completion and audit.
No failed/late proposal is partially persisted. Prior proposal intent is marked
as untrusted historical context, not authoritative source. Normal exact reads are
still required for later proposals.

## Human Lifecycle And APIs

States: `PROPOSED`, `ACCEPTED`, `REJECTED`, `SUPERSEDED`. Human decision endpoints
revalidate current developer-or-higher membership and tenant ownership. Same
decision is idempotent; opposing decisions conflict. A repeated recorded decision
request after supersession reads back the current superseded row without reviving
it. AI cannot approve itself.

Human revision re-verifies source/evidence/bounds/digest and creates a new human
row with parent linkage. It begins PROPOSED with no inherited decision. Parent
locking and snapshot checks serialize revisions against decisions. Identical
request replays return the existing revision, including the preparation race
window; conflicting request reuse rejects. Unique parent and attempt identities
prevent branching/duplicate finalization.

Revision requests persist ordinary human feedback and a server-derived target in
the conversation, then use the normal bounded queue. There is no autonomous
revise-until-approved loop. If a new turn's pins differ from the parent, proposal
construction rejects instead of rebasing. Ordinary RESPOND/REQUEST_TOOLS remain
available.

Authenticated `/api/v1` routes:

- GET `/patch-proposals/:id`
- GET `/conversations/:id/patch-proposals`
- GET `/collaboration-turns/:id/patch-proposals`
- POST `/patch-proposals/:id/decision`
- POST `/patch-proposals/:id/revisions`
- POST `/patch-proposals/:id/revision-request`

List routes use scoped `afterId`/`limit` pagination and return items/nextAfterId.
Foreign resources return scoped 404; malformed input is rejected independently.
Audit events are proposed/accepted/rejected/superseded and contain only identifiers,
actor, revision, digest, counts and decision state, never source/diff/prompts.
Production raw Prisma error logging is disabled because rejected ORM write
arguments can contain complete proposal/source payloads; domain categories remain.

## Human Review UX

The collaboration workspace shows summary, author/provider, revision, exact pins,
current/stale indication, counts, canonical diff, evidence, rationale, limitations,
digest and status. Accept/reject, edit-as-new-revision and persisted revision
feedback are available. Evidence readback is independent of message pagination.
There are no Apply/Run/Commit/Push/Merge controls.

Staleness compares historical HEAD with current recorded PR HEAD, not an extra
live GitHub request. Cached metadata may lag upstream. It does not change pins or
proposal contents; acceptance never establishes current applicability. Phase 3E
would need to revalidate all preconditions, but no 3E behavior is implemented.

## Verification Boundaries

Deterministic tests and isolated runtime verification use synthetic provider and
Git transport data. The production exact Git verifier, API, PostgreSQL, Redis,
BullMQ, worker and browser paths run normally. Proof substitutes and evidence stay
ignored under `.codelens-tmp/phase3d`; local Compose is ignored and excluded from
Docker build context. No real provider calls or GitHub mutations are authorized.

Phase 3C accepted limitations remain unchanged: deterministic verification PASSED;
real Gemini investigation/tool/evidence PARTIALLY VERIFIED; final grounded
response/citations NOT VERIFIED; multi-turn real-provider collaboration NOT
VERIFIED. Phase 3D adds no real-provider quality claim, no test/application proof
for proposed code, and no exactly-once external-effect claim. Existing 91/CRITICAL
versus 78/HIGH walkthrough drift, formatting debt and expected sign-in diagnostics
are not corrected or hidden by this work.

## Proposed Commit Inventory

Exactly 30 files are proposed. Local proof drivers and their generated evidence
are not part of this inventory. Nothing has been committed or pushed.

API (10):

- `apps/api/package.json`
- `apps/api/src/collaboration/collaboration-execution.service.test.ts`
- `apps/api/src/collaboration/collaboration-execution.service.ts`
- `apps/api/src/collaboration/collaboration.module.ts`
- `apps/api/src/collaboration/collaboration.service.ts`
- `apps/api/src/collaboration/patch-content.test.ts`
- `apps/api/src/collaboration/patch-content.ts`
- `apps/api/src/collaboration/patch-proposal.controller.ts`
- `apps/api/src/collaboration/patch-proposal.service.test.ts`
- `apps/api/src/collaboration/patch-proposal.service.ts`

Web (5):

- `apps/web/src/components/workspace/conversation-panel.tsx`
- `apps/web/src/components/workspace/evidence-viewer.tsx`
- `apps/web/src/components/workspace/patch-proposal-card.tsx`
- `apps/web/src/lib/api.ts`
- `apps/web/test/patch-proposals.mjs`

AI (3):

- `packages/ai-agent/src/collaborator.test.ts`
- `packages/ai-agent/src/collaborator.ts`
- `packages/ai-agent/src/patch-protocol.test.ts`

Database (5):

- `packages/database/package.json`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261003020000_patch_proposals/migration.sql`
- `packages/database/src/client.ts`
- `packages/database/test/patch-migration.test.ts`

Shared (4):

- `packages/shared/src/contracts/collaborator.ts`
- `packages/shared/src/contracts/index.ts`
- `packages/shared/src/contracts/patch-proposal.ts`
- `packages/shared/src/enums.ts`

Dependency lock and documentation (3):

- `pnpm-lock.yaml`
- `docs/phase3d-patch-proposals.md`
- `docs/verification.md`

Proposed message: `feat(collaboration): persist immutable evidence-linked patch proposals`.
The detailed final runtime matrix is in `docs/verification.md`.
