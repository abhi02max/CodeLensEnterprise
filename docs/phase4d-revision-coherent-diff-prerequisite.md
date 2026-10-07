# Phase 4D Revision-Coherent Diff Prerequisite

Starting revision: `097d8e98576d0225647398b7b0e83f4312d796b9`.

## Architecture Decision

Decision recorded before creating the migration. Implementation and scoped local
verification are now complete. This is not hosted-CI or real-GitHub certification.

The current importer publishes PR metadata before replacing files. Repository sync
also changes PR revision metadata independently. File rows have no trustworthy
revision provenance. Historical rows must remain unverified.

Selected model: nullable published snapshot provenance on `PullRequest`, paired
with a durable per-repository/PR-number import generation fence. All files belong
to the current publication unit; publication replaces them atomically with the
metadata and provenance. Generation reservation happens before remote reads;
publication checks the reserved generation in a short transaction. No network
operation occurs inside that transaction.

An additive migration is necessary to persist the fence and nullable provenance.
No existing migration or historical row will be rewritten or backfilled.

Per-file SHA duplication cannot alone fence concurrent imports. An immutable
snapshot history entity is unnecessary for the current replacement-only cache;
historical review evidence already has separate persistence. Response-time SHA
decoration and timestamp comparisons cannot establish provenance.

## Remote Verification

Before/after PR reads detect observed movement but do not establish immutable
file provenance by themselves: a head can move away and back between reads.
The import therefore also checks the bounded PR-file result against an
immutable base/head comparison, retaining its actual merge-base identity. Any
semantic or payload mismatch fails closed. This must not silently substitute a
different comparison for GitHub's PR diff.

GitHub's compare API accepts commit SHAs and returns at most 300 files, only on
the first commit page. Missing patches do not establish binary classification.
Sources: [GitHub compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits),
[GitHub PR files API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files).

## Writer Inventory

- PR import: metadata, files and commits; requires atomic fenced publication.
- Repository sync: metadata-only; must invalidate provenance and fence imports.
- Explicit demo seed: fixture metadata/files; must leave provenance unverified.
- MCP `get_pr_diff`: delegates refresh to import, then must reload metadata as
  well as files, in repeatable-read transactions. It no longer attaches
  pre-refresh SHAs to refreshed files.
- Analysis report writer: risk labels only, not revision or file content.
- Human review training-label writer and demo reset: labels only.
- Exact Git file/snapshot verifier: bounded read-only source primitives; unchanged.

## Read Semantics

PR detail and files reads require one database snapshot and shared published
base/head/merge-base identity. Historical/unverified data stays accessible, but
cannot be represented as a verified current diff. No page read triggers import.
Patch availability is independent of revision provenance and file-set coverage.
Truncated or omitted patches are never declared complete.

`GET /api/v1/pull-requests/:id` includes `diffRevision`. The existing `/files`
endpoint remains an array, preserves raw fields such as `touchedLines`, and adds
the same identity to every row. New `/diff` returns a coherent metadata/files
envelope, including identity when there are no files. All use the existing
authenticated organization scope; foreign PR reads produce scoped not-found.

Compare `provenance`, `baseSha`, `headSha` and `mergeBaseSha` between detail and
diff responses. Both must be VERIFIED and identical before associating the patch
with the displayed revision. A different stored current base/head invalidates
verification. Independent requests may observe different publications; mismatch
is detectable, not hidden by response-time SHA copying. No generation is public.

Per-file availability: UNVERIFIED for unknown history; UNAVAILABLE for omitted
patches; PARTIAL for bounded prefixes, missing hunks or inconsistent old/new and
addition/deletion counts; AVAILABLE for represented, count-complete hunks.
File-set completeness is independently COMPLETE/PARTIAL/UNVERIFIED using stored
file count versus the verified PR changed-file count. Aggregate patch coverage
is COMPLETE/PARTIAL/UNAVAILABLE/UNVERIFIED; a verified zero-file diff is complete.
These are bounded patch-coverage classifications, not proof of full blob content,
Git object type, semantic correctness or executability. The legacy `binary`
compatibility flag is false; that does not establish text. Old rows are not rewritten.

Static analyzer coordinates refer to the post-change input (NEW side), only for
the associated analysis revision. Existing AI line coordinates have no side and
remain UNMAPPED. No provider schema or prompt changed. Existing static-analysis
line-anchor tests establish post-change coordinates, not a guarantee that every
finding falls inside displayed hunks. Detail finding counts now select the
organization/current-head run rather than an unrelated historical head.

## Publication and Migration

Remote sequence: reserve generation; read PR R1; acquire files and commits in
parallel; compare normalized bounded files and commit membership against exact
`baseSha...headSha`; retain merge-base SHA; read PR R2; reject moved revision,
changed counts or incomplete bounded acquisition; resolve local author; publish.
There is no automatic revision-retry loop. Existing connector request retries
remain bounded. Failure requires explicit retry and does not bless acquired data.

Publication conditionally updates the reserved fence generation, retaining its
row lock through the transaction. It atomically upserts PR metadata/provenance,
replaces files, and upserts commits. A newer reservation prevents an older import
from publishing, even if the newer acquisition subsequently fails. Read paths
use RepeatableRead so Prisma relation queries cannot mix publications. No network
read occurs in the publication transaction. Remote or transaction failure leaves
the previous publication intact; reservation generation alone may advance.

Repository metadata sync advances the same fence and clears all provenance in
its short transaction, conservatively even for an unchanged head. New sync rows
have null provenance. Explicit seed metadata invalidates provenance; each fixture
file write is fenced and invalidates provenance in its transaction. Seed patches,
counts and the known walkthrough risk drift are otherwise unchanged. Label-only
writers do not alter revision/patch content. No runtime-only writer was added.

The existing Phase 3 exact-Git verifier remains unchanged. Its modification-
eligibility/blob guarantees apply to patch proposals, not general PR diff cache
publication. This prerequisite reuses the connector and unified-hunk parser;
it does not create another Git object database or replace proposal verification.

Exactly one additive migration: `20261007000000_pr_diff_provenance`.
It adds four nullable PullRequest columns and the repository/PR-number generation
table with a composite key and cascading Repository foreign key. No provenance
default/backfill, historical rewrite, schema reset or destructive statement.
Final migration count: 12. New migration SHA-256:
`883415a0f00d3001f9fa5e71f832a38aba7916b7d2e55a07a143c4be00cdf698`.

## Runtime Proof

Only new project `codelens_phase4d_diff_20261007` was used. Container:
`codelens_phase4d_diff_20261007-postgres-1`; volume:
`codelens_phase4d_diff_20261007_diff_proof_data`; network:
`codelens_phase4d_diff_20261007_default`; port `127.0.0.1:35434`.
Cached pgvector/pg16, localhost-only trust authentication, synthetic data only.
No existing Docker project, database, volume or fixture was used or modified.

Eight opt-in tests ran the actual import/read/repository-sync services against
real PostgreSQL with deterministic GitHub doubles. Promise gates, not sleeps,
forced A to acquire old data, B to publish new data, and A to finish last.
A was rejected; B's head/provenance/patch remained. A publication paused after
PR upsert/file deletion still exposed the old coherent pair to another reader;
commit exposed the new pair. An invalid enum at file creation rolled back the
real transaction. Acquired-file/commit-fetch failure and observed head movement
left prior metadata/files unchanged. Foreign-tenant reads failed. Null history
became verified only after import. Sync fenced a pending import and invalidated
old provenance. Legacy `/files` array/raw-field compatibility also passed.

Fresh normal `init:container`: `empty -> 12 migrations -> RAG verification`.
Repeat: `managed -> no pending migrations -> RAG verification`. SQL showed all
12 migrations successful and their checksums matching local files. Organization,
PullRequest and RagChunk counts were all zero: no automatic seed.

Upgrade proof applied the original 11 migrations to a separate empty database,
inserted a synthetic historical PR/file, then applied only the new migration.
All four provenance columns remained null. Raw historical file fingerprint
before upgrade, after upgrade and after PostgreSQL restart:
`d1f8a34b1c925acce434c8c6257f41bc` (MD5 of row JSON, an integrity witness only).
All 12 migrations survived restart; repeat deploy found none pending.
The disposable container/network/volume were removed after verification.

This was service-level runtime proof with actual PostgreSQL, not a deployed
HTTP/browser or live-GitHub test. Existing API/auth/4C contracts were checked
through their regressions. No Phase 4D browser implementation was performed.

## Tests and Commands

- `pnpm test`: 892 passed, 21 opt-in runtime tests skipped in the ordinary suite.
- API: 466 passed, 14 skipped; AI-agent 111; GitHub 88; shared 45; database 23;
  static analysis 47 (including 11 existing line-anchor tests).
- Explicit isolated PR diff tests: 8 passed; helper/refresh tests: 6 passed.
- Existing repository-scoped PR-list PostgreSQL tests: 6 passed separately.
- Existing frontend design-system/inbox tests: 44 passed.
- Prisma validate/generate, sequential workspace typecheck and production
  package/API/web builds passed. `git diff --check` passed.
- Scoped Prettier checks passed for new files and already-formatted touched files.
  Five touched debt-bearing files fail both at HEAD and now; no claim that the
  repository's formatting debt is cleared. No Ruff/Python changes.

Reproduction commands (only point the opt-in URLs at fresh isolated databases):

```powershell
pnpm --filter @codelens/database exec prisma validate
pnpm db:generate
pnpm test
pnpm -r --workspace-concurrency=1 --if-present typecheck
pnpm build
$env:PR_DIFF_TEST_DATABASE_URL='postgresql://codelens_diff_proof@127.0.0.1:35434/codelens_pr_diff_contract_test'
pnpm --filter @codelens/api test src/pull-requests/diff-import.persistence.test.ts src/pull-requests/diff-provenance.test.ts src/mcp-tools/diff-refresh.test.ts
$env:PR_LIST_TEST_DATABASE_URL='postgresql://codelens_diff_proof@127.0.0.1:35434/codelens_pr_list_contract_test'
pnpm --filter @codelens/api test src/pull-requests/pull-requests.persistence.test.ts
node packages/database/node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json --test apps/web/test/design-system.test.tsx apps/web/test/review-inbox.test.tsx
git diff --check
```

Docker executable was host-installed outside PATH. Host-approved execution also
resolved sandbox dependency access failures; those were session limitations,
not product failures. The initial PR-list proof attempt lacked its test database;
after creating/migrating that isolated database, all six tests passed.

The seven remaining ordinary-suite skips belong to separate executor/broker
runtime proofs, not this prerequisite. No hostile-code execution was requested.

## Exact Proposed Inventory

19 files, excluding the untouched untracked Phase 4A audit:

1. `apps/api/src/mcp-tools/tool-io.schemas.ts`
2. `apps/api/src/mcp-tools/tools.factory.ts`
3. `apps/api/src/pull-requests/pull-requests.controller.ts`
4. `apps/api/src/pull-requests/pull-requests.service.ts`
5. `apps/api/src/repositories/repositories.service.ts`
6. `packages/database/package.json`
7. `packages/database/prisma/schema.prisma`
8. `packages/database/prisma/seed.ts`
9. `packages/github/src/client.ts`
10. `packages/github/src/diff-parser.ts`
11. `packages/shared/src/contracts/repository.ts`
12. `apps/api/src/mcp-tools/diff-refresh.test.ts`
13. `apps/api/src/pull-requests/diff-import.persistence.test.ts`
14. `apps/api/src/pull-requests/diff-provenance.test.ts`
15. `apps/api/src/pull-requests/diff-provenance.ts`
16. `docs/phase4d-revision-coherent-diff-prerequisite.md`
17. `packages/database/prisma/migrations/20261007000000_pr_diff_provenance/migration.sql`
18. `packages/database/test/pr-diff-migration.test.ts`
19. `packages/github/src/diff-provenance.test.ts`

Ignored proof configuration/copies remain under `.codelens-tmp/phase4d/` only.
No environment files, provider credentials, screenshots or generated reports are
in this inventory. Scoped recognized credential-pattern scan found zero matches;
that is not universal secret-leak certification and did not read C2 credentials.

## Existing Migration Integrity

Every original migration and lock was compared byte-for-byte with starting HEAD:

| Migration                                 | SHA-256                                                          |
| ----------------------------------------- | ---------------------------------------------------------------- |
| 0_baseline                                | e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab |
| 20261002000000_conversation_foundation    | b9612e1f2663739f7d65cbeedff30a9ba2e34e4f8c9d36b3cb24cf7f7afb100d |
| 20261002010000_investigation_foundation   | 04389bfda10486cdad8dd270a0a9bfa3555941d783a2b78d1acf7f4259e07a49 |
| 20261003000000_collaborator_execution     | 155ff9b3ce0e62eeb85e01a4d836241f074499746519375dcbd65e26eff0bc52 |
| 20261003010000_exact_revision_foundation  | 8ba03deb4064138cf3bd9f045228045dbaf645f2b1d7329d9508a327792faf1a |
| 20261003020000_patch_proposals            | e80aba620ac102ddb7c01595f203420f980893a0fbe3a22feda6ce6dfe5b430b |
| 20261003030000_patch_applications         | 4194709460af95302a3a71810dc531c1ade06db125a6cb2e9ebc33b0e8513b64 |
| 20261004000000_validation_runs            | 8b0719e1910e6c061611dc5a326b410442d6553c1a8f16d732d1b51fca8a6c80 |
| 20261004010000_validation_static_findings | b8b07bde8b5ed064320824091539be4385e2fb8ebe82843db2b470ed37d29822 |
| 20261005000000_validation_ml_assessments  | 90f3890a4ced49c447e2de013f085c0b84413c828612209284a9180b9f8fe484 |
| 20261005010000_validation_ai_rereviews    | 0de414388a389c40e7a9037f025139bb6f9733c25c4cf5d4599303bcc32975ee |
| migration_lock.toml                       | da12fa8151832c7297598b1504d698d41d7b1f6331b5bb7f458e8725356ba9c8 |

Phase 4A audit SHA-256 remains
`a64f828808d5eb3dd5fb72e3179432f6af7b2c03e414b9bca0e877343c98d08c`.

## Adversarial Review

1. New metadata/old files cannot be published VERIFIED through audited writers:
   one transaction and repeatable-read composition cover publication/readback.
2. Old metadata/new files: same protection; publication-pause proof passed.
3. Stale A cannot overwrite newer B: reserved generation conditional write passed.
4. Observed movement rejects import; ABA file contamination is checked against
   immutable comparison payload. Remote movement after verification remains possible.
5. Remote/DB failures do not partially publish; real rollback and acquisition proof passed.
6. Historical rows remain null/UNVERIFIED; upgrade fingerprint survived.
7. Missing patch no longer implies binary in parser, API or MCP readback.
8. Browser can identify the stored diff revision, not assert live GitHub freshness.
9. Detail/files endpoints share comparable identity; new envelope handles zero files.
10. Import, repository sync, explicit seed and MCP refresh obey the invariant;
    labels-only writers do not change source identity.
11. No static rules, ML, RAG or AI-provider semantics changed. The intended bounded
    commit acquisition now actually respects the pre-existing 250-commit cap.
12. Organization scoping and foreign-tenant not-found proofs passed.
13. Static coordinates are NEW-side analyzer input coordinates at the run revision.
14. AI side remains ambiguous/UNMAPPED; no provider schema workaround.
15. Four nullable columns plus one fence table, not an immutable Git cache database.
16. Certified-schema upgrade succeeded without fabricated history or row rewrite.
17. Fresh normal initialization and repeated initialization succeeded.
18. Existing 4C real persistence and frontend inbox tests passed.
19. No UI, renderer, rails, line markers or later-phase features were added.
20. Remaining limitations below are explicit; no universal remote-freshness claim.

Scoped corrections found during review: preserved the legacy files-array/raw-field
contract, added a separate zero-file envelope, fenced metadata-only sync and seed
writes, reloaded MCP metadata after refresh, enforced the intended commit cap,
and removed formatter-only churn outside changed connector/tool regions.

## Limitations and Handoff

- No real GitHub API import was exercised here. Immutable-compare matching fails
  closed if fork/API permission or PR/compare semantics do not align; their live
  compatibility is not newly certified. Local doubles cannot prove all GitHub behavior.
- File acquisition remains capped at 300 and commits at 250. Different bounded
  PR/compare candidate subsets reject import; no fabricated complete file set.
- Provenance certifies the normalized persisted bounded payload, not omitted blob
  bytes, complete file text, object mode, future remote head, or whole commit history.
- Existing commit upsert retains historical commit rows after force-push; the
  published identity certifies files, not that historical commit list.
- Availability checks use existing hunk parsing and count coverage, not a new
  full unified-diff validator. Binary classification is still unknown.
- Newer failed reservations can conservatively fence older valid acquisitions.
  Explicit retry is required; no exactly-once or universal liveness claim.
- Arbitrary privileged direct database writes are outside service writer guarantees.
- Historic demo/analysis files remain accessible but unverified, never exact-source
  evidence. AI line-side ambiguity and existing formatting/risk/diagnostic debt remain.
- No hosted CI, browser diff UI, external provider calls, fixture changes, GitHub
  product writes, RAG indexing, human verdicts or candidate execution occurred.

After this prerequisite is separately approved/committed/certified, Phase 4D may
consume the typed `/diff` envelope and compare its identity to PR detail, display
UNVERIFIED/partial/unavailable states, map static NEW-side findings only at matching
analysis revision, and leave AI findings UNMAPPED. It must not refresh on page open
or represent missing patches as binary. Phase 4D UI has not resumed.

## Verification Status

Recommendation: **READY_TO_FREEZE_PREREQUISITE**.

Starting and final HEAD: `097d8e98576d0225647398b7b0e83f4312d796b9`.
Working tree: 19 proposed files (11 modified, eight new), plus the untouched
untracked Phase 4A audit. Nothing staged, committed or pushed.
Proposed subject: `fix(api): publish revision-coherent PR diff snapshots`.
Focused contracts, real PostgreSQL atomicity/concurrency, lifecycle, regressions
and adversarial review: PASSED within the stated boundaries. Stop before commit,
push or Phase 4D UI.

## Requested Freeze Checklist

1. Starting HEAD: `097d8e98576d0225647398b7b0e83f4312d796b9`.
2. Final HEAD: same; no commit or push.
3. Working tree: 11 modified/eight new proposed files plus untouched Phase 4A audit; unstaged.
4. Exact proposed inventory: the 19 paths above.
5. Architecture: bounded verified publication is feasible; no larger redesign required.
6. All writers: import, repository sync, explicit seed, MCP refresh, report labels, human training labels and reset labels audited above.
7. Storage: nullable PR publication identity plus durable per-repository/number fence.
8. Alternatives: per-file identity alone cannot fence; immutable snapshot history is unnecessary; response decoration is insufficient.
9. Schema: four nullable provenance fields and one generation table.
10. Migration: `20261007000000_pr_diff_provenance`.
11. History: null/UNVERIFIED, no fabricated backfill.
12. Remote reads: reserve, R1, parallel files/commits, immutable comparison, R2, publish.
13. Atomicity: conditional fence lock and metadata/files publication in one transaction.
14. Remote fence: immutable normalized payload match plus R1/R2 consistency.
15. Concurrent fence: durable incremented generation and transactional conditional ownership.
16. Stale writer: fails explicitly; cannot overwrite newer publication.
17. Failures: acquired-data and transaction failure preserve previous publication.
18. Detail: additive `diffRevision`, coherent relation read.
19. Files: legacy array preserved; additive row provenance and separate `/diff` envelope.
20. Identity: published base/head/merge-base and verification state, not generation.
21. Browser mismatch: compare verified identities; reject mismatch or unknown state.
22. Availability: AVAILABLE/PARTIAL/UNAVAILABLE/UNVERIFIED, count-coverage semantics.
23. Completeness: independently classified file set and aggregate patches.
24. Null patch: unavailable/unknown, never authoritative binary.
25. Static mapping: existing 11 line-anchor tests establish NEW-side analyzer input.
26. AI mapping: existing side ambiguity remains UNMAPPED; provider schema unchanged.
27. Main importer: remote verification before atomic fenced publication.
28. Secondary paths: sync/seed invalidate and fence; MCP reloads metadata and files together.
29. Analysis: regression suites passed; no new provider/static/ML/RAG behavior; capped commit acquisition corrected.
30. Security: existing authorization retained; foreign-tenant read proofs passed.
31. Verified import runtime: real PostgreSQL service-level identity/readback passed.
32. Movement: two metadata reads, rejection and unchanged persisted snapshot passed.
33. Concurrent A/B: deterministic promise-gated stale A rejection passed.
34. Failure preservation: remote acquisition and actual DB transaction rollback passed.
35. Historical: upgrade null provenance and unchanged file; later verified import passed.
36. Focused contracts: five helper tests passed.
37. Import/refresh: eight persistence tests and one MCP refresh test passed.
38. Real PostgreSQL: eight new and six existing 4C tests passed separately.
39. API ordinary suite: 466 passed, 14 opt-in tests skipped; those 14 passed separately.
40. Shared: 45 passed.
41. Database: 23 passed.
42. Frontend: 44 existing foundation/inbox tests passed; no new UI/browser proof claimed.
43. Workspace: 892 passed, 21 opt-in skips; remaining seven separate sandbox proofs not rerun.
44. Typecheck: sequential workspace check passed.
45. Builds: production package/API/web builds passed.
46. Prisma: validate and generate passed.
47. Fresh: normal empty initialization applied all 12 migrations, no seed; repeat managed initialization passed.
48. Upgrade: original 11 to 12 succeeded with unchanged historical file/null provenance.
49. Restart: migration history, historical fingerprint and null provenance survived.
50. `git diff --check`: passed.
51. Prettier: checked new/formatted touched files passed; five baseline debt-bearing files remain debt-bearing.
52. Existing migration hashes: full byte-identical inventory above.
53. Final migration count: 12, exactly one new.
54. Migration lock: byte-identical, SHA-256 above.
55. Baseline: `e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.
56. Provider calls: none.
57. GitHub mutations: none; no fixture change or external sync/import.
58. RAG mutations: no indexing or seed; only empty isolated schema initialization/readiness verification.
59. Secrets/config: synthetic local proof only; ignored copies/config excluded; recognized credential patterns zero.
60. 4C regression: six existing PostgreSQL tests and 28 inbox frontend tests passed.
61. Phase 4D UI: not implemented/resumed.
62. Limitations: exact live-GitHub compatibility, freshness, capped data, binary/AI-side ambiguity and historical commits disclosed above.
63. Adversarial review: 20 answers and scoped corrections above; no unresolved local blocker.
64. Proposed subject: `fix(api): publish revision-coherent PR diff snapshots`.
65. Recommendation: **READY_TO_FREEZE_PREREQUISITE**, not committed/certified.
