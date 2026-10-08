# Phase 4D Code-First Review Workspace

## Scope And Certification Boundary

Starting and final HEAD: `0d8c07202ff7e4efde4f98df24f1b6e411be8777`.
The consumed revision-coherent diff prerequisite is certified by exact-SHA
hosted CI run `37647137855`. This UI changeset is local, uncommitted verification
evidence, not new hosted CI certification.

No backend, shared contract, dependency, CI, schema, migration, analysis engine,
provider or domain implementation changed. No commit or push occurred.

## Proposed Inventory

Exactly nine files belong to this changeset:

1. `apps/web/src/app/(app)/reviews/[id]/page.tsx`
2. `apps/web/src/lib/api.ts`
3. `apps/web/src/lib/review-workspace.ts`
4. `apps/web/src/components/workspace/review-workspace.tsx`
5. `apps/web/src/components/workspace/review-diff.tsx`
6. `apps/web/src/components/workspace/review-workspace.css`
7. `apps/web/test/review-workspace.test.tsx`
8. `docs/phase4d-code-first-review-workspace.md`
9. `apps/web/Dockerfile`

The pre-existing untracked Phase 4A audit is not part of the inventory. Its
SHA-256 remains `a64f828808d5eb3dd5fb72e3179432f6af7b2c03e414b9bca0e877343c98d08c`.
All local proof/configuration/runtime files remain ignored and unstaged.

## Architecture And Truthful Source Treatment

The route reads the existing review-session aggregate, then makes exactly two
parallel reads for PR detail and `/pull-requests/:id/diff`. Detail contributes
revision metadata only; its unused files/commits are not retained in the query
cache. `/diff` is the sole primary code source. No per-file requests, import,
sync or hidden analysis is introduced. The new diff queries do not poll or
refetch on window focus; explicit refresh rereads existing stored data.

Both detail and diff must be VERIFIED with complete base/head/merge-base
identities. PR IDs, repository identity, session/detail head, detail base,
diff envelope base/head and revision/completeness metadata must agree.
Missing/unverified/mismatched identity hides patch content and prevents line
mapping. Verified means an imported stored snapshot, not a live freshness check.

The existing pure `packages/github/src/diff-parser.ts` is imported directly,
without the package's GitHub client/Node entry point. There is no second diff
parser. The renderer escapes source through React, distinguishes old/new
coordinates and additions/deletions/context, and preserves no-newline metadata
as metadata rather than source. Only the selected file is rendered.

The frontend Docker builder now copies the existing GitHub workspace manifest
and this one pure parser source. The manifest enables normal frozen-lockfile
workspace resolution of its shared types; no dependency or lockfile changed,
and no GitHub client implementation is copied or invoked. An initial parser-only
copy compiled webpack but failed TypeScript dependency resolution. Adding the
existing manifest corrected that packaging omission; the final image built.

Static mapping requires a non-stale run at the displayed head, an exact unique
path, an AVAILABLE untruncated patch and exactly one matching NEW-side hunk
coordinate. Partial patches, missing/out-of-hunk coordinates and ambiguous
paths/coordinates remain UNMAPPED. Coordinate indexes are cached per file for
one mapping computation, not rebuilt for every finding. AI coordinates remain
UNMAPPED because the contract supplies no authoritative side/revision anchor.
No fuzzy snippet, previous-path or OLD-side matching occurs.

Finding snippets and AI suggestions are contextual recorded/advisory content,
not replacements for the PR diff. AI reference strings remain model-provided
tool-run references in disclosure, not newly certified exact-source citations.
The selected file can expose its existing recorded AI explanation. Multiple
findings share a count marker and remain individually selectable in navigation
and context. Source and severity are independently labeled.

## Layout And Existing Capabilities

Changes is the default surface: files/findings navigation, code center,
selection-driven context. The header retains repository/PR identity, author,
branches, recorded head, state, file/change totals, analysis status and stored
ML risk. Analyze is secondary and still explicit. Back to Reviews preserves
repository scope using the existing local encoded URL helper.

At 1440, the code center is 760px with 200px navigation and 304px context,
inside the unchanged application shell. Context collapses first at 1280/1100;
code centers are 914px/766px. At 800 navigation becomes a dialog and code is
656px. At 390 code is 390px, with file/finding and context dialogs. Long paths
wrap; source scrolls horizontally inside its bounded code container, not the
page. Fixed font sizes and existing semantic tokens are used.

The center owns desktop vertical scrolling; navigation/context scroll only
when necessary. The workspace measures remaining viewport height below the
shell, including a late-arriving/resized health banner. Native modal dialogs
provide focus trapping, Escape dismissal and opener-focus return. No keyboard
shortcut submits a domain mutation. These are scoped tested controls, not WCAG
certification or an exhaustive accessibility audit.

Secondary Discussion retains existing comments/replies/resolution and
conversation/evidence components. Existing proposals, revisions, isolated
materialization, validation/static/ML/AI assessment components remain reachable
through the existing selected conversation/proposal chain. No fake global
Candidates or History contract is introduced. Analysis exposes existing
AI/risk/metrics/RAG/tool evidence and actual failure/degradation/provenance.
Decision retains existing gate, head-bound verdict and permission-bound sharing
controls. Organization activity is restricted to OWNER/ADMIN and labeled as
organization activity, not complete PR history. Mutation handlers and verdict
preconditions remain unchanged. The PR diff is not a proposal or candidate diff.

## Isolated Browser Evidence

User-approved project: `codelens_phase4d_ui_20261007`.
Containers: `codelens_phase4d_ui_20261007-postgres-1` and
`codelens_phase4d_ui_20261007-redis-1`.
Network: `codelens_phase4d_ui_20261007_default`.
No persistent volumes: PostgreSQL data and Redis data use disposable tmpfs.
Ports: PostgreSQL loopback 56421, Redis loopback 56391, host API 55422,
production frontend loopback 53422. The existing API listener is all-interface;
this disposable local test is not deployment/network-hardening certification.
Existing Docker projects/volumes were neither reused nor changed.

All twelve unchanged migrations applied to the empty database. The approved
normal deterministic seed created one repository, two PRs, one seeded run,
four static findings, one ML prediction, one AI review, three RAG chunks,
two comments, one verdict and no conversations/candidates/validations.
PR #412 retains its unchanged +26/-5/four-file seed. This is not live analysis.
One initial seed invocation ran before migration completion and failed because
Organization did not exist; the seed succeeded after initialization completed.
No reset, data-loss flag, schema change or existing-volume fallback occurred.

The REAL seeded API/browser proof verifies its actual UNVERIFIED diff state:
stored patch source is not rendered as trusted code; Discussion, Analysis and
Decision remain reachable without executing their mutation controls.

The separately approved SYNTHETIC proof intercepts browser GET read responses
only. It supplies coherent verified revision metadata and deterministic patches
and findings to exercise rendering/mapping/layout. It never writes VERIFIED
provenance or fixture edits into the database. It does not prove live GitHub
import, source correctness, AI quality or production semantic retrieval quality.
All external browser origins and all non-auth product writes were refused.

Final browser result: 50 checks passed against the final production build,
zero browser runtime exceptions and zero attempted forbidden product mutations.
All five workspace bottoms match the viewport (900px desktop/tablet, 844px
mobile), with no page horizontal overflow. File/finding keyboard selection,
visible navigation focus, dialog Escape/opener return, read retry and loading/
empty/not-analysed/failed states passed. An initial geometry check exposed a
34.6px late-banner overrun; observing the actual shell header fixed it. Initial
synthetic driver pin/envelope errors were corrected to the existing plain-JSON
contract, without database provenance changes.
Expected initial unauthenticated refresh 401 responses and synthetic outage
503 responses remain disclosed; no console-silencing change was made.

All 49 non-auth/audit domain tables are fingerprinted before/after final
navigation. User/account/audit records are excluded because login/session
activity is explicitly allowed. All 49 domain fingerprints matched after the final pass. Both containers and
the network were removed; zero project containers/networks/volumes or listeners
remain on the four isolated ports. The local preview is no longer running.

Eight screenshots are outside the repository under the approved visualization
directory's `phase4d` subdirectory: real UNVERIFIED 1440, synthetic finding 1440,
synthetic Changes at 1440/1280/1100/800/390, and synthetic context dialog 390.
They are verification artifacts, not proposed tracked files.

## Tests, Formatting And Limitations

Focused tests: 61 passed. Existing frontend tests: 44 passed. Combined: 105
passed, zero failures/skips. Workspace regression: 892 passed, 21 opt-in
platform/persistence/runtime cases skipped. API: 466 passed/14 skipped;
AI-agent: 111; static: 47; GitHub: 88; shared: 45; database migration/lifecycle:
23; RAG: 29; patch-core: 23; patch-executor: 10; sandbox-broker: 12;
validation-executor: 28/4 skipped; validation-broker: 10/3 skipped.

Sequential workspace typechecks, package/broker/executor builds, unchanged API
production build, frontend production build and Prisma validate/generate pass.
The frontend Docker production build also passed. A separate disposable image
smoke container, `codelens_phase4d_ui_20261007-image-proof`, used network `none`,
no ports, credentials or volumes. Default pnpm startup could not complete its
registry-dependent supply-chain verification offline and exited. This is not
claimed as a successful default offline startup. Directly starting the already
built Next.js server returned HTTP 200 for `/signin` and `/reviews/proof`;
`.env`, `.codelens-tmp` and frontend test paths were absent in the image.
This is unauthenticated packaging/SSR proof, not another live API/browser proof.
The proof container and unique `codelens-phase4d-ui-20261007:proof` image tag
were removed. No existing runtime resource was changed or pruned.
An initial frontend launcher cwd error was corrected in ignored infrastructure,
not by changing Tailwind/product configuration. An initial package build hit
Windows EPERM because the new API held Prisma's DLL; stopping only that API
allowed normal generation/builds to pass. These are disclosed test-setup errors,
not hidden successful runs.

Canonical tracked-extension Prettier debt: 137 at starting HEAD, 136 after,
with no new tracked failures. The redesigned route's old failure is removed.
New frontend files and the route pass scoped Prettier (CSS explicitly checked).
`api.ts` retains its pre-existing whole-file formatting debt; only six already
formatted import/GET-wrapper lines were added. No unrelated mass formatting.
The tracked-file measurement honors `.prettierignore`; it is not a claim that
the raw repository glob passes ignored-directory permission errors.
No Python/Ruff file or debt changed.

The direct-color inventory includes named numeric color families and white/black
bg/text/border/ring utilities. New workspace/diff code uses zero direct-color
utilities. Four existing utility matches remain in untouched verdict/metrics
logic; remaining legacy panel colors are not migrated. Redesigned route: 15 to
4 utility matches. Whole tracked TSX source: 196 to 185 matches across 23 files.
New untracked workspace files add zero direct-color utilities. Counts exclude
tests and are textual inventory, not unique visual defects.

Existing 91/CRITICAL walkthrough expectations versus unchanged 78/HIGH seed
remain untouched. Mutation-bearing old browser suites are not run under this
read-only authorization; the scoped browser journey replaces them for 4D proof.
Existing legacy deep-panel clipping/long-ID/design debt is not declared fixed.
No virtualization was added: selected-file rendering/memoized parsing is bounded
by the existing diff contract; very large production diff performance remains
unbenchmarked. Responsive proof covers five Chrome viewports, not every browser,
zoom, assistive technology or pathological title/viewport combination.

The 21st CLI/design-context files are unavailable locally. Existing 4A inspiration,
4B tokens/primitives and 4C shell conventions were used, without installing a
dependency or making AI-generation/provider calls.

Reproducible local checks (from repository root):

```powershell
node packages/database/node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json --test apps/web/test/design-system.test.tsx apps/web/test/review-inbox.test.tsx apps/web/test/review-workspace.test.tsx
pnpm test
pnpm -r --workspace-concurrency=1 --if-present typecheck
pnpm build:packages
pnpm --filter @codelens/api build
pnpm --filter @codelens/web build
pnpm db:validate
pnpm db:generate
git diff --check
```

Do not run seed against an existing database or reuse local secrets to recreate
proof. The ignored runtime driver/configuration is local evidence, not permanent
product infrastructure; it should remain excluded from commits. The production
Docker exclusion already excludes `.codelens-tmp`, frontend tests and docs.

## Adversarial Product Review

| Question                   | Conclusion                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| 1. Code dominance          | Verified `/diff` is the default center; real unverified source remains honestly absent.           |
| 2. Diff versus snippets    | Only `/diff` feeds primary code; snippets are labeled contextual recorded data.                   |
| 3. File to code            | Immediate local selection; no per-file read.                                                      |
| 4. Static finding to code  | Exact NEW coordinate only; keyboard and marker selection tested synthetically.                    |
| 5. AI mapping              | Always unmapped; no inferred side/revision.                                                       |
| 6. Revision uncertainty    | Explicit unverified/missing/mismatch state.                                                       |
| 7. Patch uncertainty       | File availability and aggregate completeness independent and visible.                             |
| 8. Null patch              | No fabricated binary claim or source.                                                             |
| 9. Source/severity         | Independent labels.                                                                               |
| 10. Wide center            | 760px at 1440 inside the shell.                                                                   |
| 11. Laptop collapse        | Context becomes dialog before code narrows.                                                       |
| 12. 800                    | Navigation/context dialogs; 656px center.                                                         |
| 13. 390                    | Full-width center and native dialogs, bounded horizontal source scrolling.                        |
| 14. Scroll predictability  | Center vertical ownership; corrected late-banner sizing.                                          |
| 15. Nested scroll          | Horizontal code scroll intentionally separate; nav/context independent only as needed.            |
| 16. Raw IDs                | No primary raw job/run IDs; optional AI tool references remain disclosed, not resolved citations. |
| 17. Cards/pills            | Unframed primary workspace; old secondary cards retained without deep redesign.                   |
| 18. AI hierarchy           | Source code is default; advisory AI remains context/Analysis/Discussion.                          |
| 19. Candidate separation   | No proposal/candidate bytes enter the PR diff.                                                    |
| 20. Phase 3 reachability   | Existing conversation/proposal/candidate chain retained; no mutation re-proof claimed.            |
| 21. Mutations              | Existing handlers/permissions/head preconditions retained; navigation performs reads only.        |
| 22. Backend                | No changed backend files.                                                                         |
| 23. Migrations             | Twelve existing SQL files and lock unchanged; none added.                                         |
| 24. Developer-tool quality | Compact identity, predictable navigator, conventional unified diff and subordinate context.       |
| 25. Remaining awkwardness  | Legacy secondary panel colors/clipping and large detail disclosures remain deferred.              |

Scoped adversarial fixes: hide untrusted source; reject incoherent identities;
avoid fuzzy/ambiguous mapping; share per-file coordinate parsing; discard duplicate
detail patch data from cache; label contextual snippets; correct viewport height
when the health banner arrives; preserve readable mobile controls and dialog
focus return. No test-only production branch, fixture path/port, token, provider
configuration, automatic operation or backend workaround is introduced.
The final packaging review also corrected the frontend Docker builder's omitted
pure parser/workspace manifest, without changing runtime startup policy.

## Exact Freeze Checklist

| #   | Item                  | Result                                                                                                                                     |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Starting HEAD         | `0d8c07202ff7e4efde4f98df24f1b6e411be8777`.                                                                                                |
| 2   | Final HEAD            | Same; no commit/push.                                                                                                                      |
| 3   | Working tree          | Uncommitted nine-file inventory plus unchanged untracked audit.                                                                            |
| 4   | Proposed inventory    | Exact nine paths listed above.                                                                                                             |
| 5   | Frontend architecture | Route orchestration, pure identity/mapping, selected-file renderer, scoped geometry.                                                       |
| 6   | Backend/API changes   | None; two frontend GET wrappers only.                                                                                                      |
| 7   | /diff usage           | Authoritative primary diff envelope.                                                                                                       |
| 8   | PR detail             | Revision metadata only cached; not the code source.                                                                                        |
| 9   | Revision verification | Matching verified IDs/base/head/merge-base and completeness.                                                                               |
| 10  | VERIFIED              | Imported snapshot labeled, no live freshness claim.                                                                                        |
| 11  | UNVERIFIED            | No authoritative source/anchors; discussion remains usable.                                                                                |
| 12  | Mismatch              | Explicit warning, hidden code/anchors, read refresh.                                                                                       |
| 13  | File completeness     | COMPLETE/PARTIAL/UNVERIFIED reported without inference.                                                                                    |
| 14  | AVAILABLE             | Existing unified hunks rendered.                                                                                                           |
| 15  | PARTIAL               | Supplied content only, omitted-content warning, no finding anchors.                                                                        |
| 16  | UNAVAILABLE           | Explicit absence, not a binary inference.                                                                                                  |
| 17  | Patch null            | No fabricated content or hunk.                                                                                                             |
| 18  | Header                | Compact PR/source/author/branches/counts/status/stored risk.                                                                               |
| 19  | Back                  | Local encoded repository-scoped Reviews link.                                                                                              |
| 20  | Workspace             | Changes primary; local Discussion/Analysis/Decision views.                                                                                 |
| 21  | Scroll                | Center viewport ownership; late-banner correction.                                                                                         |
| 22  | Files                 | Filterable changed paths/status/counts/availability.                                                                                       |
| 23  | Selection             | Immediate diff/context update; selected state visible.                                                                                     |
| 24  | Findings              | Static plus separately labeled advisory AI.                                                                                                |
| 25  | Severity/source       | Independently visible.                                                                                                                     |
| 26  | Static coordinates    | Exact NEW-side current-run matching only.                                                                                                  |
| 27  | Finding to file       | Exact filename selection; no fuzzy path rewrite.                                                                                           |
| 28  | Finding to line       | Highlight/nearest reveal only for valid coordinate.                                                                                        |
| 29  | AI                    | UNMAPPED with reason.                                                                                                                      |
| 30  | Out of hunk           | UNMAPPED; no invented surrounding code.                                                                                                    |
| 31  | Multiple findings     | Count marker, separate navigation/context choices.                                                                                         |
| 32  | Markers               | Accessible NEW-line finding counts.                                                                                                        |
| 33  | Parser                | Existing pure shared GitHub parser, no client entry point.                                                                                 |
| 34  | Unified rendering     | Old/new columns, context/add/delete, multiple hunks, metadata and escaped text.                                                            |
| 35  | Context               | Follows file/finding selection, not chatbot default.                                                                                       |
| 36  | Evidence              | Existing advisory references/snippets; no new exact-source authority.                                                                      |
| 37  | Discussion            | Existing comments and conversations retained.                                                                                              |
| 38  | Candidates            | Existing proposal/application/validation chain; no fake global tab.                                                                        |
| 39  | History               | Authorized organization activity, not fabricated PR history.                                                                               |
| 40  | Analyze               | Secondary explicit existing action; never invoked during proof.                                                                            |
| 41  | Phase 3               | Existing source component chain retained; advanced mutation behavior not repeated.                                                         |
| 42  | Source separation     | PR diff never proposal/materialized/validated candidate.                                                                                   |
| 43  | Loading               | Named bounded skeleton.                                                                                                                    |
| 44  | Error                 | Diff failure separate from review failure; explicit GET retry.                                                                             |
| 45  | Empty                 | No files/findings/not analysed distinguished; not a safety claim.                                                                          |
| 46  | Large/partial         | Selected-file rendering, no silent patch fabrication/truncation; large-scale benchmark deferred.                                           |
| 47  | Performance           | Three fixed initial reads; no N+1, no polling/duplicate retained detail patches.                                                           |
| 48  | 1440                  | Synthetic visual proof, 760px center; final bottom equals 900px.                                                                           |
| 49  | 1280                  | Synthetic visual proof, 914px center, context dialog.                                                                                      |
| 50  | 1100                  | Synthetic visual proof, 766px center, no three-column squeeze.                                                                             |
| 51  | 800                   | Synthetic visual proof, 656px center, navigation/context dialogs.                                                                          |
| 52  | 390                   | Synthetic visual proof, 390px center, no page horizontal overflow.                                                                         |
| 53  | Mobile context        | Native modal, named close, Escape/focus return.                                                                                            |
| 54  | Keyboard/focus        | File/finding selection, drawer keyboard open/Escape, visible focus checked.                                                                |
| 55  | Accessibility         | Scoped checks only, no exhaustive/WCAG claim.                                                                                              |
| 56  | Browser journey       | 50 passed: real unverified plus separate synthetic state/interaction/layout proof.                                                         |
| 57  | Screenshots           | Eight external artifacts, visually inspected; not committed.                                                                               |
| 58  | Focused tests         | 61 passed, local evidence only.                                                                                                            |
| 59  | Existing frontend     | 44 passed; 105 combined.                                                                                                                   |
| 60  | Workspace             | 892 passed/21 explicitly skipped.                                                                                                          |
| 61  | Typecheck             | Sequential workspace pass.                                                                                                                 |
| 62  | Builds                | Packages/brokers/executors/API/final web and Docker builds passed; direct-server image smoke passed, default offline pnpm startup did not. |
| 63  | Prisma                | Validate/generate pass.                                                                                                                    |
| 64  | Diff check            | Tracked diff passes; new files checked separately before freeze.                                                                           |
| 65  | Prettier              | New files/route pass; pre-existing api.ts whole-file debt retained; 137 to 136 tracked failures.                                           |
| 66  | Scoped direct colors  | Route 15 to 4; four unchanged legacy helper matches. New surfaces zero.                                                                    |
| 67  | Whole TSX colors      | Source-only informational count 196 to 185 across 23 TSX files.                                                                            |
| 68  | Migration count       | Twelve, zero new.                                                                                                                          |
| 69  | Integrity             | All twelve byte-identical to HEAD.                                                                                                         |
| 70  | Lock                  | Unchanged.                                                                                                                                 |
| 71  | Baseline SHA          | `e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.                                                                        |
| 72  | Prerequisite SQL      | SHA `883415a0f00d3001f9fa5e71f832a38aba7916b7d2e55a07a143c4be00cdf698`, unchanged.                                                         |
| 73  | Domain/security       | No implementation change; all 49 domain-table fingerprints unchanged.                                                                      |
| 74  | Provider calls        | None.                                                                                                                                      |
| 75  | GitHub mutations      | None; no GitHub import/read required for proof.                                                                                            |
| 76  | RAG                   | No indexing/retrieval/mutation after approved demo initialization.                                                                         |
| 77  | Secrets/config        | Scoped common credential-pattern scan: no matches; ignored runtime/config excluded.                                                        |
| 78  | Audit                 | Untracked/unchanged/excluded; hash above.                                                                                                  |
| 79  | Limitations           | Synthetic verified UI proof; no live import/provider claim; debt/skip/401/clipping limits retained.                                        |
| 80  | Deferred 4E           | Findings/comments/evidence and contextual AI conversation redesign.                                                                        |
| 81  | Deferred 4F           | Proposal/candidate inspector and unified evaluation/history presentation.                                                                  |
| 82  | Deferred 4G           | Final decision, permitted history and public-share presentation.                                                                           |
| 83  | Adversarial review    | Scoped corrections and remaining boundaries documented above.                                                                              |
| 84  | Proposed subject      | `feat(web): add revision-aware code-first review workspace`.                                                                               |
| 85  | Recommendation        | READY_TO_FREEZE. Disposable runtime cleaned; no commit, push or later phase.                                                               |
