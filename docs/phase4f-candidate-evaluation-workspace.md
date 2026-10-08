# Phase 4F Candidate Evaluation Workspace

## Freeze Status

**READY_TO_FREEZE.** Frontend implementation and the scoped read-only browser
proof passed. Nothing was committed or pushed. Phase 4G has not started.

Starting and final HEAD: `d3c2f282461cc1e9700f169711b89a185034e720`.
Parent: `7960c822c3ad34d8bd13b28dca7e33e586f954e0`.
Starting subject: `feat(web): integrate contextual investigation and collaboration`.
The starting tracked tree was clean; the unrelated untracked Phase 4A audit
remains unmodified and excluded from the proposed inventory.

This is presentation work, not new evaluation infrastructure. There are no API,
shared-contract, database, migration, provider, static-rule, ML, RAG, dependency,
CI or sandbox-policy changes.

## Proposed Inventory

Exactly 12 files, six modified and six new:

| File                                                            | Change                                                                                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/app/(app)/reviews/[id]/page.tsx`                  | Mount Candidates and its scoped stylesheet; retain existing route-controlled conversation selection.                                           |
| `apps/web/src/components/workspace/review-workspace.tsx`        | Add secondary Candidates view; Changes remains default.                                                                                        |
| `apps/web/src/components/workspace/patch-proposal-card.tsx`     | Reuse existing decisions in compact decision-only mode; retain evidence access and disclose that revision feedback requests an assistant turn. |
| `apps/web/src/components/workspace/validation-ai-panel.tsx`     | Check selected lineage; selected active polling; safe read failure; navigable recorded citations and structured evidence disclosure.           |
| `apps/web/src/components/workspace/validation-ml-panel.tsx`     | Check selected lineage; selected active polling; safe read failure; recorded features/warnings disclosure.                                     |
| `apps/web/src/components/workspace/validation-static-panel.tsx` | Require two distinct complete sides; compact source-identity disclosure; withhold failed reads and avoid duplicate initial refresh.            |
| `apps/web/src/components/workspace/candidate-workspace.tsx`     | New bounded conversation/proposal navigation, explicit revision selection, canonical patch view and human decision composition.                |
| `apps/web/src/components/workspace/candidate-evaluation.tsx`    | New selected materialization/validation navigation, paired checks, bounded diagnostics and evidence sections.                                  |
| `apps/web/src/components/workspace/candidate-workspace.css`     | New semantic-token, unframed responsive layouts; contained diff/log/table scrolling.                                                           |
| `apps/web/src/lib/candidate-evaluation.ts`                      | New association, manifest, active-state and canonical-hunk completeness helpers.                                                               |
| `apps/web/test/candidate-evaluation.test.tsx`                   | New 65 deterministic semantic frontend tests.                                                                                                  |
| `docs/phase4f-candidate-evaluation-workspace.md`                | This contract, implementation, evidence and freeze report.                                                                                     |

Excluded: `docs/phase4a-product-experience-audit.md`, all `.codelens-tmp` drivers,
local Compose configuration, generated proof JSON, `.next`, screenshots and other
ignored/local artifacts. No proof helper is imported by production code.

## Contract Audit

Sources inspected include the actual controllers and services under
`apps/api/src/collaboration/`, shared contracts under
`packages/shared/src/contracts/`, existing `apps/web/src/lib/api.ts` wrappers,
Phase 3 persistence/security tests, and Phase 4A through 4E documentation.

`SUPPORTED` means a checked-in authoritative API exists. `SAFELY DERIVABLE`
means presentation can be computed from that API without inventing evidence.
`UNSUPPORTED` is disclosed or deferred, not filled with fabricated data.

| Capability                      | Classification                 | Actual contract and boundary                                                                                                                                                    |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Proposal listing             | SUPPORTED                      | `GET /conversations/:id/patch-proposals` and turn-scoped equivalent; bounded cursor pages. No PR-global proposal list.                                                          |
| 2. Proposal details             | SUPPORTED                      | `GET /patch-proposals/:id`; list views also contain canonical files/edits and identity.                                                                                         |
| 3. Proposal creation            | SUPPORTED                      | Existing bounded collaboration `PROPOSE_PATCH`, or human revision; not a generic patch RPC. Creation remains in existing collaboration UX.                                      |
| 4. Revisions                    | SUPPORTED                      | New immutable records with `parentId`, author and revision; no content update in place.                                                                                         |
| 5. Revision identity            | SUPPORTED                      | Proposal ID, revision, digest, originating conversation/turn and pinned base/head.                                                                                              |
| 6. Immutability                 | SUPPORTED                      | Existing proposal service, database constraints/triggers and migration; unchanged.                                                                                              |
| 7. Human decisions/edit         | SUPPORTED                      | Decision, revisions and revision-request POST endpoints; existing request IDs and expected revision/digest retained.                                                            |
| 8. Proposal authorization       | SUPPORTED                      | Controller `RequireRole(DEVELOPER)`, authenticated current organization/member and scoped service reads; no new client-defined privilege.                                       |
| 9. Materialization requests     | SUPPORTED                      | Explicit `POST /patch-proposals/:id/applications` for accepted proposals. Never invoked by navigation.                                                                          |
| 10. Materialization status      | SUPPORTED                      | Application list/detail: persisted status, cleanup, failure category and attempts.                                                                                              |
| 11. Candidate identity          | SUPPORTED                      | Application/proposal revision/digest, exact base/head, snapshot and attempt manifest digest.                                                                                    |
| 12. Source provenance           | SUPPORTED                      | Existing exact-revision snapshot/executor result associations; no frontend reconstruction.                                                                                      |
| 13. Candidate source comparison | SAFELY DERIVABLE / UNSUPPORTED | Canonical proposal hunks plus matching modified-file hashes are available. Full candidate blob content is NOT exposed; no second reconstructed repository/diff.                 |
| 14. Original validation         | SUPPORTED                      | `ValidationView.steps` side `ORIGINAL` means pinned PR HEAD, not BASE.                                                                                                          |
| 15. Candidate validation        | SUPPORTED                      | Side `PATCHED` for the selected materialized candidate.                                                                                                                         |
| 16. Paired association          | SUPPORTED                      | Validation application/proposal/revision/digest/head/snapshot/candidate identities; candidate digest equals materialization manifest digest.                                    |
| 17. Commands/scope              | SUPPORTED                      | Existing fixed `typescript-typecheck-v1` and `vitest-unit-v1` profiles only. No new command input or arbitrary execution.                                                       |
| 18. Diagnostics                 | SUPPORTED                      | Broker observations, exit/termination/duration/OOM/cleanup, bounded excerpts, capture-completeness and separate untrusted runner reports.                                       |
| 19. Static comparison           | SUPPORTED                      | `GET /validations/:id/static-findings`; authoritative classifications, side, path, line, coverage and cursor/filter semantics.                                                  |
| 20. ML                          | SUPPORTED                      | Nullable latest `GET /validations/:id/ml-assessment`; optional known comparison ID on server. Recorded paired scores, model identity, features, warnings and frozen metadata.   |
| 21. AI                          | SUPPORTED                      | Nullable latest `GET /validations/:id/ai-rereview`; optional known review ID. Recorded claims, sealed evidence, coverage, identity and accounting. No invented tools/streaming. |
| 22. Evidence                    | SUPPORTED                      | Existing persisted evidence GET/viewer; proposal references and AI sealed packet citations remain distinct.                                                                     |
| 23. Audit/history               | SUPPORTED                      | Existing server audit events; no new timeline or inferred history. Complete ML/AI history enumeration is not exposed by these wrappers.                                         |
| 24. Queue state                 | SUPPORTED                      | Persisted lifecycle status, not invented live queue position.                                                                                                                   |
| 25. Retry                       | SUPPORTED / UNSUPPORTED        | Read retry is available; existing explicit new requests use existing idempotency semantics. No new generic execution retry or exactly-once claim.                               |
| 26. Cancellation                | SUPPORTED                      | Existing explicit cancel POSTs. Recorded cancellation is not a universal remote-termination guarantee.                                                                          |
| 27. Idempotency                 | SUPPORTED                      | Existing UUID request ownership and server replay/fencing; not changed.                                                                                                         |
| 28. Tenant/repository/PR scope  | SUPPORTED                      | Authenticated organization and current membership are server-derived; scoped parent reads. Frontend additionally checks returned conversation/proposal and execution identity.  |
| 29. Pagination                  | SUPPORTED                      | Existing ID cursor lists (default 25, bounded maximum 50); explicit First/More controls reset dependent selections.                                                             |
| 30. API hooks                   | SUPPORTED                      | Existing typed wrappers and TanStack Query cache patterns reused; no wrapper/contract changes.                                                                                  |

No critical backend contract blocker was found. Full candidate blobs, arbitrary
commands, complete ML/AI history and remote freshness checks are not required or
invented by this slice.

## Experience And Authority

The imported PR Changes view remains default. Candidates provides explicit
conversation and proposal/revision selectors. No revision is silently selected
as latest. Origin labels use the recorded conversation anchor kind, not a guessed
finding relationship. Changing parent/page/revision unmounts downstream state.

The selected proposal has Patch, Evaluation and Human decision sections. Patch is
default and loads no application/validation/ML/AI results. It has selected-file
navigation, old/new coordinates, color-independent +/- labels, hunk headers,
context and contained horizontal scrolling. The existing shared parser is reused
and memoized; the transport's final newline is excluded before hunk counting.
Missing or count-inconsistent hunks are labeled unavailable or partial. Only
canonical server-generated hunks are rendered, never full source reconstructed
from a partial patch. React escapes source text; no unsafe HTML is introduced.

Evaluation explicitly selects a materialization and then a validation. The
frontend checks proposal/revision/digest/pins and requires matching successful,
disposed attempt results. All modified files must match old blob/content and new
content hashes; duplicate result paths fail closed, while legitimate unchanged
manifest files are permitted. Validation must also match the snapshot/manifest
identity. Mismatches withhold child evidence rather than selecting a convenient
run. These checks supplement, not replace, server authorization and integrity.

Checks show original HEAD and patched candidate per recorded profile, including
missing/ambiguous steps. Server comparison enums are displayed, not recomputed
into a quality score. Diagnostic disclosures distinguish broker observations
from untrusted runner summaries. Complete capture does not imply complete
display or exhaustive testing; absent logs do not imply any outcome. Excerpts
remain bounded by existing server capture limits and contained scrolling.

Static uses recorded occurrence-level classifications and locations. A summary
requires two distinct COMPLETE sides; missing/partial analysis is not clean.
Source/ruleset identities are available by disclosure. Static findings are not
mapped onto the imported PR's code lines as if candidate coordinates were PR
coordinates. RESOLVED means no longer detected, not proven fixed.

ML shows paired scores in tenths/100 and recorded delta/band movement, not an
invented probability or confidence. Model identity, frozen inputs and recorded
features/warnings remain available. Missing output is unavailable, not zero.
AI shows only the recorded advisory result and cited packet evidence. Clicking a
citation opens its disclosures and focuses the target. The selected validation's
lineage is checked for both AI output and its ML request prerequisite. Failed or
mismatched readback cannot be replaced with another candidate's success.

The existing proposal card supplies human accept/reject/edit and revision
feedback, without duplicating its old diff/application stack in Candidates.
Acceptance still means approval for a future application stage, not PR approval,
merge, validation or safety. Revision feedback explicitly discloses that it
persists a human message and requests a bounded configured-provider turn.
No mutation is optimistic or automatic. Actual Phase 3 operations remain explicit
and server-authorized; they were NOT invoked during this proof.

Staleness is against server-recorded current head, not a new GitHub freshness
check. Historical content remains inspectable with warnings; no silent rebase or
claim of current applicability. Final PR verdict, sharing, audit, original code,
Discussion and contextual investigation remain reachable, not redesigned.

## Query, Failure And Accessibility Behavior

Only selected sections mount their queries. Conversation/proposal/materialization/
validation reads use bounded pages; selected active execution states poll while
mounted. ML/AI poll at 1500 ms only while active, and stop on terminal/null states.
Static polls only for the selected active validation, and refreshes when it
transitions to terminal, without an extra initial effect refresh. These paths do
not refetch on window focus. Existing legacy Discussion application panels remain
available; their broader polling behavior is not represented as globally fixed.

Read errors, loading, empty, stale, failed/cancelled persisted states and missing
evidence have explicit feedback. Failed refreshed reads withhold cached selected
results. Materialization/validation/ML/AI request controls disable while their
authoritative prerequisite read is pending, failed, active or mismatched as
appropriate. Server rules remain decisive. Read retries do not enqueue work.

Existing semantic tokens/primitives are reused. Sections are unframed, typography
compact, identities disclosed rather than the primary surface. Desktop uses a
file rail and wide unified code view; at 800 px and below files stack above one
code view. There are no side-by-side unreadable mobile code columns or decorative
media. Only selected diagnostics expand. File buttons have native keyboard
activation, visible focus and current selection; section buttons are named
pressed-state controls, not incomplete ARIA tabs. Materialization and validation
selects have explicit accessible names independent of their option text.

Proof used reduced-motion preference, native disclosures, color-independent
change labels and the existing context dialog's Escape/focus return. This is
scoped accessibility evidence, not WCAG certification, a screen-reader audit or
proof of every browser/platform. No consequential keyboard shortcut was added.

## Browser Proof: Real And Synthetic

Explicit authorization covered ONE new disposable database, the documented demo
seed, real demo login/session/refresh, workers disabled and synthetic GET-only
product fixtures. Authentication, authorization middleware, users and tokens were
not mocked. No synthetic candidate/conversation/evidence row was written to SQL.

Production Next build ID: `RoBhfVv89bd4vhBMD7jgZ`.
Chrome headless, reduced motion; final production build, not a development server.
Final browser run: **54 assertions passed**, zero browser runtime exceptions and
zero forbidden product requests attempted.

REAL: fresh migration deployment and pre-seed empty state; documented seed;
signin/refresh; seeded PR/session/detail/diff; imported provenance UNVERIFIED;
empty candidate history; return to original Changes, contextual investigation,
existing Decision and Reviews. Seeded risk remains 78/HIGH, not fabricated 91/CRITICAL.

SYNTHETIC: persisted-conversation list and proposal revisions; canonical hunk and
file navigation; materialization/validation readback; paired outcomes and partial
logs; static classifications; advisory ML and recorded AI/citations; historical
human decision controls; mismatched associations; unavailable ML, failed AI;
stale, partial and unavailable patches. These prove presentation mechanics only,
not live candidate execution, validation persistence, provider quality, conversation
persistence or current remote GitHub state.

Final network record: 72 real GETs, 44 synthetic GETs, 15 real authentication
POSTs (one signin, 14 refresh). Synthetic endpoints were fulfilled only for GET.
No authentication endpoint was intercepted with fake responses. No materialize,
validate, static/ML reassess, AI re-review, proposal decision/revision, conversation,
comment, verdict, share, import/sync, provider or RAG request was made. All outbound
browser origins other than the two proof origins were denied, with zero attempts.

Console diagnostics remain disclosed: initial unauthenticated refresh 401 and a
scoped GET 404 for `/conversations/synthetic-conversation` when returning to
investigation. Only the synthetic list/readback states were provided, not a
persisted conversation detail; the real server truthfully returned not found.
Neither diagnostic is a browser runtime exception. They were not suppressed or
converted into successful authentication/persistence evidence. Capability banner
also truthfully reports missing provider key and unavailable ML service.

Screenshots were captured and visually inspected outside the repository under
`C:/Users/Abhid/.codex/visualizations/2026/09/25/01a0d889-618a-7a03-9b23-98b04b1fa90e/phase4f/`.
They include real empty state, patch/source detail and paired checks at all five
widths, mobile static/ML/AI and human decision, plus desktop AI/decision.

| Viewport | Page width | Code width | Result                                                                                                             |
| -------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| 1440     | 1440       | 1012       | Wide file/code layout; keyboard focus; contained source scrolling and checks.                                      |
| 1280     | 1280       | 852        | No page overflow; readable unified hunks and checks.                                                               |
| 1100     | 1100       | 704        | Secondary context remains collapsible; wide-enough code; existing dialog Escape/focus return checked.              |
| 800      | 800        | 624        | Files stack above unified diff; contained checks; no page overflow.                                                |
| 390      | 390        | 366        | One code view with internal long-line scroll, wrapping paths and controls; static/ML/AI/decision remain contained. |

## Isolation And Cleanup

Project: `codelens_phase4f_ui_20261008`.
Containers: `codelens_phase4f_ui_20261008-postgres-1`,
`codelens_phase4f_ui_20261008-redis-1`,
`codelens_phase4f_ui_20261008-api-1`.
Database/user: `codelens_4f_ui`. PostgreSQL and Redis data used tmpfs; no persistent
volume was requested or reused. Ports: PostgreSQL 56441, Redis 56394, API 55442,
Next 53442; loopback bindings only. Provider/GitHub credentials were empty,
ephemeral server auth/encryption keys generated locally, API workers disabled.

The initial internal network suppressed host-port publication on this Docker
Desktop. A second NEW owned bridge, `codelens_phase4f_ui_20261008_loopback`, was
attached only to the owned API/PostgreSQL containers to restore loopback access.
The same database/container was retained; no second seed or existing database
fallback. Default internal network:
`codelens_phase4f_ui_20261008_default`. This local harness adjustment did not
change tracked Compose, security policy or product code. The additional bridge is
not claimed to provide infrastructure-level egress prevention.

Fresh initialization reported empty and applied all 12 checked-in migrations.
Before the explicitly approved seed: organizations, PRs, conversations, proposals
and RAG chunks were zero. After seed, candidate-domain records remained zero.
Fingerprints of 49 product tables before/after all browser attempts were identical;
auth-related User/Account/AuditLog and migration metadata were intentionally
excluded from that comparison. Audit readback showed the five seed event types
plus login events only. This is scoped product non-mutation evidence, not proof of
byte-identical session storage.

Cleanup completed: all three containers, both proof networks and their tmpfs data
removed; production Next process stopped; unique API image tag removed. No TCP
LISTENING entry remained for any of the four proof ports. The captured prior
container IDs and volume names were all retained. No existing certified resource
was restarted, removed, reseeded or used as fallback. Docker build cache and
ignored local proof records are not runtime services and are not committed.

## Local Verification

| Gate                               | Actual result                                                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New frontend tests                 | 65 passed.                                                                                                                                                                                                      |
| All existing frontend tests        | 148 passed.                                                                                                                                                                                                     |
| Combined frontend                  | 213 passed, zero failures/skips.                                                                                                                                                                                |
| Workspace tests (`pnpm test`)      | 892 passed, 21 existing opt-in/platform skips.                                                                                                                                                                  |
| API                                | 466 passed, 14 skipped.                                                                                                                                                                                         |
| AI-agent                           | 111 passed.                                                                                                                                                                                                     |
| Database migration/lifecycle tests | 23 passed.                                                                                                                                                                                                      |
| Other workspace packages           | Shared 45; GitHub 88; static 47; RAG 29; patch-core 23; patch-executor 10; sandbox-broker 12; validation-executor 28 + 4 skips; validation-broker 10 + 3 skips.                                                 |
| Sequential typecheck               | PASS, `pnpm -r --workspace-concurrency=1 --if-present typecheck`.                                                                                                                                               |
| Production builds                  | Packages, brokers/executors, API and production Next PASS.                                                                                                                                                      |
| Prisma                             | Validate/generate PASS; validate used only explicit disposable DATABASE_URL (first environment-less attempt failed for missing URL, not schema defect).                                                         |
| Browser                            | Final production build: 54 assertions PASS, five widths; no forbidden writes/runtime exceptions.                                                                                                                |
| Diff integrity                     | `git diff --check` PASS; LF/CRLF advisory warnings are not whitespace errors.                                                                                                                                   |
| Formatting                         | All 12 proposed files pass scoped Prettier, CSS included. Canonical tracked-file comparison remains 136 failures at HEAD and working tree, zero new failures; new files checked separately. No mass formatting. |
| Ruff                               | No Python/config files changed; not rerun. Existing Ruff debt remains, not reclassified as clean.                                                                                                               |
| Migration integrity                | 12 SQL files and lock byte-identical to HEAD; zero migrations added.                                                                                                                                            |

Frontend command:

```powershell
node packages/database/node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json --test apps/web/test/design-system.test.tsx apps/web/test/review-inbox.test.tsx apps/web/test/review-workspace.test.tsx apps/web/test/investigation-context.test.tsx apps/web/test/candidate-evaluation.test.tsx
```

Deterministic tests cover association mutations on every identity field, manifest
preconditions/duplicates/unchanged files, lifecycle eligibility, canonical parsing,
coordinates/HTML escaping, unavailable/partial hunks, explicit historical revisions,
paired missing/duplicate steps, bounded diagnostics semantics, null/failed/mismatched
ML/AI readback, loading/error and cached-read failure, empty/foreign conversations,
incomplete/duplicate-side static analysis and active/terminal helper semantics.
Browser checks cover interactive selection, focus, scrolling, citations, real
authentication, terminal polling and complete read-only navigation.

No claim is made that these standalone frontend tests run in hosted CI. No new
hosted exact-SHA certification exists for this uncommitted slice.

Required SHA-256 values rechecked:

| File                                              | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `0_baseline/migration.sql`                        | `e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab` |
| `20261007000000_pr_diff_provenance/migration.sql` | `883415a0f00d3001f9fa5e71f832a38aba7916b7d2e55a07a143c4be00cdf698` |
| `migration_lock.toml`                             | `da12fa8151832c7297598b1504d698d41d7b1f6331b5bb7f458e8725356ba9c8` |
| Phase 4A audit                                    | `a64f828808d5eb3dd5fb72e3179432f6af7b2c03e414b9bca0e877343c98d08c` |

No direct color-family utility was added to new production surfaces; the new CSS
uses existing semantic tokens. Unchanged legacy panels retain disclosed direct
color utilities, legacy metadata and styling debt. No repository-wide cleanup.
The tracked `apps/web/src` TSX inventory of bg/text/border/ring white/black or
named numeric color-family utilities is unchanged at 183 before and 183 after;
new candidate source files contain zero such literals.

## Adversarial Review

No outstanding blocker was found in the scoped final diff. Corrections made before
freeze: require matching manifest files rather than equating candidate hashes to
proposal identity; require both distinct static sides; withhold cached readback on
failed refresh; disable AI requests on unavailable ML prerequisite; stop terminal
polling; make selects explicitly named; keep source/ruleset hashes behind disclosure;
retain evidence navigation in compact decisions; disclose provider effect of feedback.

| Review question                 | Conclusion                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Primary comparison           | Patch default, wide unified source surface; no execution results loaded by default.                                                          |
| 2. Object authority             | Imported PR, immutable proposal and materialized manifest explicitly distinct.                                                               |
| 3. Revision selection           | Explicit conversation and immutable revision; no inferred latest.                                                                            |
| 4. Cross-candidate evidence     | Application/validation/ML/AI checks and keyed unmounting withhold mismatches; synthetic negative cases passed.                               |
| 5. Stale/mismatch               | Mismatch withheld; stale history marked without rebasing or pretending remote freshness.                                                     |
| 6-7. Missing/partial patch      | Named unavailable/partial states; no reconstructed missing source.                                                                           |
| 8. Paired checks                | Recorded profile/side pair; missing or duplicate steps remain ambiguous.                                                                     |
| 9. Logs/failure                 | Recorded categories/observations, separate untrusted summaries, explicit capture omissions.                                                  |
| 10-11. Static                   | Selected validation-scoped GET, distinct complete sides, backend classifications only; no candidate-to-PR anchor guessing.                   |
| 12-13. ML/AI                    | Advisory, recorded inputs/output and limitations; missing risk never fabricated as zero.                                                     |
| 14. Human authority             | Existing explicit decisions; acceptance does not imply PR approval or validation.                                                            |
| 15. Hidden execution            | No effect/query handler invokes mutations; final network and domain fingerprints confirm no product operation.                               |
| 16. Permission                  | No authentication/middleware/backend changes or fabricated authorization; existing guards remain authoritative.                              |
| 17-18. Git/source safety        | No GitHub write, new shell command, unsafe HTML or source execution.                                                                         |
| 19-20. Responsive/accessibility | Five-width inspection, contained scrolling, keyboard/current/focus; existing dialog Escape/return. Scoped only, not WCAG certification.      |
| 21-22. Reachability             | Original code, investigation, Discussion/Assistant and Phase 3 explicit controls retained; final Decision/sharing not redesigned or invoked. |
| 23. Later phases                | History/PR verdict/sharing 4G, broader quality/accessibility/error debt 4H, brand refinement 4I deferred.                                    |
| 24. Query bounds                | Parent/selected paged reads, selected evidence mounts, active-only polling, server-bounded logs; no fetch per proposal list item.            |
| 25. Scope                       | Frontend/test/doc only; no backend/schema/provider/security-policy changes.                                                                  |
| 26. Evidence claims             | Real auth/seed reads separated from synthetic candidate fixtures; no live execution/provider/persistence inference.                          |
| 27. Cleanup                     | Owned disposable runtime removed; prior resources retained; proof ports closed.                                                              |
| 28. Reviewer value              | One selected revision and candidate chain replaces a disconnected full execution-card stack; canonical code stays primary.                   |

Local 21st catalog search could not proceed without sign-in. Automated 21st review
was blocked by the execution safety reviewer because it could transmit private
source to an external service. No workaround, login, source upload or new service
credential was used. Existing design context, source review and local screenshots
provided the design evidence; no external design-review pass is claimed.

Credential-pattern checks are scoped to proposed files, not universal non-leakage
proof. The owned API log check compared all three ephemeral server secret values
and found zero matches; all external provider/GitHub keys were empty. No browser
headers, tokens, session response bodies or credential values were saved in proof
network records. Existing diagnostic redaction remains unchanged.

## Remaining Boundaries

- No live candidate execution, new validation, static/ML reassessment, provider
  re-review, proposal decision/edit or new conversation persistence was tested in
  this read-only UI slice. Existing Phase 3 evidence is not upgraded.
- Full original/candidate blobs and complete ML/AI history are not available;
  canonical hunks/hash evidence and latest selected readbacks are labeled accordingly.
- No automatic remote PR freshness check, sync, import, rebase or provider request.
- Existing legacy Discussion metadata/polling and some direct-color utilities remain.
- Expected pre-login 401, synthetic unpersisted-context 404, degraded capability
  banner and prior broader clipping observations remain disclosed. The known
  91/CRITICAL walkthrough expectation versus unchanged 78/HIGH seed drift is untouched.
- Browser evidence is Chrome at tested widths/preferences, not exhaustive accessibility,
  all browsers, permissions/mutation execution proof or production readiness.
- Prettier/Ruff debt is preserved. No hosted CI or full browser walkthrough pass
  for this uncommitted revision is claimed.
- Phase 4G final PR decisions/history/sharing redesign, 4H broad QA/performance/
  accessibility cleanup, and 4I enterprise brand refinement are not implemented.

Preserved Phase 3C statuses: deterministic verification PASSED; real Gemini
investigation/tool/evidence PARTIALLY VERIFIED; real final grounded response/
citations NOT VERIFIED; real multi-turn collaboration NOT VERIFIED.
Real provider AI re-review remains NOT VERIFIED. No such call was made in 4F.

## Requested Freeze Checklist

1. Starting HEAD: `d3c2f282461cc1e9700f169711b89a185034e720`.
2. Final HEAD: identical; no commit or push.
3. Tree: six tracked modifications and six new proposed files; unrelated untracked 4A audit retained; ignored proof artifacts excluded. Nothing staged.
4. Exact proposed inventory: the 12-file table above.
5. Contract audit: 30 capabilities classified above; no critical blocker.
6. Boundary: frontend/test/doc only.
7. IA: secondary Candidates; Patch/Evaluation/Human decision; selected Checks/Static/ML/AI.
8. Proposal selection: conversation-scoped paged listing, explicit selection.
9. Revision selection: immutable ID/revision/digest, parent/history visible.
10. Distinctions: imported PR, proposed hunks, materialized hashes, paired observations and decisions separately labeled.
11. Code: canonical unified hunks, selected file, old/new coordinates, +/-/context, contained scrolling.
12. Missing/partial: unavailable or inconsistent hunk state; no fabricated source.
13. Materialization: exact persisted status/cleanup/failure and matching manifest; no validation inference.
14. Validation: recorded fixed profiles/steps/logs and comparison enums.
15. Pair: selected application plus proposal/pins/snapshot/manifest fencing.
16. Static: server classifications, distinct complete side pair; source identities disclosed.
17. ML: advisory paired scores, missing output unavailable; actual features/identity accessible.
18. AI: recorded advisory claims/citations, coverage, status and lineage; no new execution.
19. Human decisions: existing explicit semantics/control payloads; future-application approval only.
20. Permissions/audit: server current membership/role/scoped reads unchanged; no new client authority or audit mutation.
21. Async: named pending/empty/error/stale/mismatch; persisted lifecycle; failed reads withhold cached results.
22. Phase 3 reachability: retained explicit original controls; no live execution claim from 4F.
23. 4G: verdict/history/sharing preserved, not redesigned.
24. 4H/4I: broader QA/accessibility/performance and brand debt deferred.
25. 1440: visual/keyboard/patch/checks PASS, code width 1012.
26. 1280: PASS, code width 852.
27. 1100: PASS, code width 704; existing context dialog tested.
28. 800: PASS, stacked unified layout, code width 624.
29. 390: PASS, code width 366; static/ML/AI/decision contained.
30. Keyboard/focus: native file selection, visible focus, citation focus, dialog Escape/return; reduced motion used.
31. Accessibility limits: no WCAG/screen-reader/all-platform certification.
32. Performance: bounded pages, selected mounts, memoized parser and active-only polling; no global legacy cleanup claim.
33. Journey: real login to Reviews/PR, selected synthetic candidate chain, return to real Changes/investigation/Decision/Reviews PASS.
34. Proof boundary: real auth/seed reads; synthetic GET-only candidates; no synthetic SQL writes.
35. Screenshots/cleanup: external screenshot directory above; all owned runtime services/networks/data/tag removed; no proof listeners remain.
36. New frontend: 65 PASS.
37. Combined frontend: 213 PASS, zero skips.
38. Workspace: 892 PASS, 21 existing skips.
39. Typecheck: sequential PASS.
40. Builds: packages/brokers/executors/API/production Next PASS.
41. Prisma: validate/generate PASS.
42. Diff check: PASS.
43. Scoped formatting: all 12 proposed files PASS; tracked debt 136 -> 136.
44. Direct colors: no new production-surface literals; existing legacy debt disclosed.
45. Migrations: exactly 12, all byte-identical to starting HEAD.
46. Lock: byte-identical.
47. Hashes: required baseline/provenance/lock hashes listed above.
48. 4A: required SHA-256 unchanged; excluded from inventory.
49. Provider calls: NONE.
50. GitHub product mutations: NONE.
51. RAG mutations: only specifically authorized deterministic seed rows in the new disposable DB; no indexing or post-seed mutation.
52. Candidate execution attempts: NONE; workers disabled, forbidden product POSTs zero.
53. Secret/config/artifacts: scoped source-pattern and API ephemeral-value log checks pass; ignored drivers/config/generated records remain outside proposed inventory.
54. Adversarial review: scoped corrections above, no outstanding blocker; diagnostic/contract limitations disclosed.
55. Limitations: preserved in Remaining Boundaries, including Phase 3C provider limitations.
56. Proposed subject: `feat(web): add revision-safe candidate evaluation workspace`.
57. Recommendation: **READY_TO_FREEZE**. STOP before commit/push; no Phase 4G work.
