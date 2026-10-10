# Phase 4H: Product Quality, Accessibility and Performance

## Discovery Status

**PHASE_4H_SCOPE_SPLIT_REQUIRED.** Initial source discovery is recorded below;
this is not a final freeze report or completed application-wide browser audit.
No product code has changed. No runtime has been initialized, seeded or started.
No commit, push, provider request or product mutation has occurred.

Starting/current HEAD: `f5f22b54391ec5790530038681eed285884bfa46`.
Starting subject: `feat(web): integrate human review decisions history and sharing`.
The tracked tree was clean. The protected untracked Phase 4A audit was present
with its required hash. The only proposed tracked addition is this document.

The requested coverage spans ten implemented routes, six review modes, legacy
proposal/evaluation surfaces, nine viewport widths, keyboard/reflow/contrast and
large-data/performance checks. Separate bounded slices are recommended before
expanding implementation. No P0 or P1 security defect has been established by
this initial inspection; this is not a security clearance.

## Evidence and Inspection Boundary

Actual route/component sources, primitives, global tokens, package commands,
Next configuration, session handling, and existing frontend tests were inspected.
Phase 4A-G documentation informs prior evidence and deferrals; historical browser
results are not counted as new Phase 4H verification. Source discovery remains
in progress, especially detailed stress states and complete mutation-handler
review. A route being inventoried does not mean it was browser-tested.

Existing tools: React 19, Next 15.1.6, TanStack Query 5.64.2, native controls and
dialogs, Lucide, Tailwind semantic `--cl-*` tokens, Playwright 1.49.1, installed
tsx/node:test and Vitest. No dependency was added. No `.21st/design.json` exists.

Local deterministic `21st review apps/web/src --json` examined 60 files:
0 errors, 7 warnings, 81 suggestions. These are scanner results, not confirmed
defect counts. Several suggestions incorrectly flag `rgb(var(--cl-*)))` token
usage as hardcoded colors; fixed-width warnings flag bounded max-width classes;
the reduced-motion CSS itself triggers a transition-all warning. No automatic
fix was applied. Autofocus warnings require contextual keyboard verification.

`axe-core`, `@axe-core/playwright` and `lighthouse` are not locally resolvable
from the web project. Their absence limits automated accessibility/performance
coverage; no installation or WCAG/Core Web Vitals certification is authorized
or implied. Existing contrast tests calculate token combinations but do not
measure every rendered direct-color/opacity combination.

## Actual Route Inventory

All Phase 4H runtime columns currently mean **NOT TESTED**, not passed.

| Route                    | Reachability / authorization                    | Primary behavior and states                                      | Responsive/keyboard/performance checks still required                                                    |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/`                      | Public session resolver                         | Redirect to dashboard/signin; loading text                       | Announced loading, redirect focus and request count                                                      |
| `/signin`                | Public; authenticated redirect                  | Credential form, independent GitHub action, pending/error        | Labels/error association, autofill, keyboard, narrow layout, contrast; no GitHub action execution        |
| `/auth/callback`         | Public recovery surface                         | Sanitized outcome, cookie recovery, connected-state confirmation | Loading/failure layout/focus; no live OAuth replay or fabricated auth                                    |
| `/dashboard`             | Authenticated app shell                         | Existing review inbox                                            | Repository/state/risk/order filters, loading/empty/error, pagination, stress and route timing            |
| `/pull-requests`         | Authenticated app shell                         | Same review inbox; URL filters                                   | Direct navigation/back/filter preservation, narrow controls and list scale                               |
| `/repositories`          | Authenticated                                   | Repository read/pagination; explicit connect/sync controls       | Empty/error separation, long names, buttons, keyboard; never invoke sync/connect                         |
| `/reviews/[id]`          | Authenticated scoped session and PR reads       | Code-first workspace and secondary modes                         | All nested modes below, provenance, dialogs, contained code scrolling and query fan-out                  |
| `/activity`              | Authenticated shell; API ADMIN/OWNER permission | Organization audit read                                          | Permission vs transport error, long actions, readable timestamps, keyboard and retry                     |
| `/shared/[token]`        | Existing public allowlisted reader              | Token/passphrase read, SUMMARY/FULL, unavailable/loading         | Synthetic GET only for successful views; prevent real share view/audit writes; long content and keyboard |
| `/shared/review/[token]` | Public compatibility route                      | Same-origin encoded 307 to canonical reader                      | Redirect-only contract; no duplicated payload/auth logic                                                 |

No standalone organization, team or settings route exists in this source tree.
Such routes are NOT APPLICABLE to current-route verification, not implemented
features. Framework not-found/error behavior also needs inspection; no custom
route-level error/loading/not-found files were found in the route inventory.

## Component and Workflow Quality Inventory

| Family / actual implementation                              | Preserved contract                                                                      | Audit work                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| AppShell / PrimaryNav / HealthBanner / ListPagination       | Role-aware destinations, skip link, mobile disclosure, bounded list pages               | Resize-open focus, Escape/return, skip-link target, long organization, status and request counts                              |
| UI primitives / risk / analyze-button                       | Native controls, named feedback, distinct advisory states, explicit execution           | Rendered contrast, disabled/loading names, reduced motion, touch targets; no analysis execution                               |
| ReviewInbox / ReviewList / repository list                  | URL filters, server paging, stored risk labeled as stored                               | Empty/error/retry, long titles/options, full width matrix and deterministic list stress                                       |
| ReviewWorkspace / ReviewDiff / findings                     | Shared selection, exact provenance, NEW-side mappings only when supported               | File/finding keyboard navigation, selected state, code region focus, table coordinates and revision invalidation              |
| InvestigationPanel / EvidenceViewer / ConversationPanel     | Server-scoped recorded evidence and explicit tool/message actions                       | Citation return focus, unusable/foreign/stale data, context reselection, long messages and active-only reads                  |
| CommentsPanel / ContextPanel / AI/Risk/ToolRuns panels      | Existing scoped reads and explicit writes, missing results not invented                 | Labels, error announcements, long diagnostics and truthful incomplete states; no sends                                        |
| CandidateWorkspace / CandidateEvaluation                    | Explicit parent/revision/attempt selection, lineage checks                              | Canonical hunks, selection reset, table scrolling, loading/error and stress; no materialization                               |
| PatchProposalCard / PatchApplicationPanel / ValidationPanel | Existing human decisions and restricted execution                                       | Legacy terminal polling and disclosures; no decisions/execution/validation requests                                           |
| ValidationStatic/Ml/Ai panels                               | Source-specific readback and selected lineage                                           | Partial/missing output, citations, filters, logs and selected active polling; no new assessments                              |
| DecisionWorkspace / ReviewConfirmation                      | Head-bound human verdict, deliberate native modal, overwrite history disclosure         | Dialog focus/Escape/pending state, stale target, history scale and error recovery; no verdict writes                          |
| SharePanel / shared reader                                  | Creation-only raw URL, metadata-only history, SUMMARY/FULL and existing token semantics | Copy-denial/late-settlement checks without real creation, reader reflow and passphrase feedback; no share access side effects |
| Providers / api-client / use-job-polling                    | Real cookie recovery, authorization, cache clearing, status ambiguity                   | Real signin/refresh/logout, failure feedback and protected-route recovery; no auth mocking                                    |

Candidate conversation/proposal selectors are already implicitly labeled by
their wrapping `<label>`. An initial label-risk hypothesis was dismissed after
checking actual composition; it is not a verified defect or reason for edits.
Review mode controls are pressed-state groups, not incomplete ARIA tabs.

## Initial Defect Inventory

Source references below are reproducible evidence. Browser impact and priority
will be reconfirmed before product edits. No screenshot has yet been captured.

| ID / severity | Surface, user impact and reproduction                                                                                                           | Root cause / source evidence                                                                                      | Proposed bounded correction                                                                                      | Security / regression / verification                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4H-001 / P2   | Activity: a failed read tells an authorized user that access is admin-only. Return a network/500 error on audit GET.                            | `activity-panel.tsx:41-44` uses the same permission copy for every error.                                         | Distinguish 403 from network/server/unavailable, expose safe GET retry.                                          | No permission expansion; low presentation risk; error-category tests and synthetic GET browser check. 4H-A.                                                      |
| 4H-002 / P2   | Signin: assistive users cannot associate returned field errors with email/password. Inspect form after validation failure.                      | Inputs set aria-invalid but have no aria-describedby; error paragraphs have no IDs.                               | Stable error IDs and input association, preserve native validation and hydration safety.                         | No auth contract changes; low markup risk; semantic tests and real invalid-login path. 4H-A.                                                                     |
| 4H-003 / P2   | Signout failure has no visible recovery and may produce an unhandled rejection. Reject the existing auth request in a focused component test.   | App layout passes `() => void signOut()`; provider awaits API before local cleanup without caller error handling. | Truthful pending/failure presentation; do not claim remote session revocation on ambiguous outcome.              | Security-sensitive semantics must remain unchanged; medium risk; focused auth failure test, real happy-path logout only until extra failure authorization. 4H-A. |
| 4H-004 / P2   | Legacy proposal/application/validation views repeatedly fetch terminal or empty history while mounted. Count requests over a fixed idle window. | Proposal interval 2000 ms; application and validation intervals 1000 ms are unconditional.                        | Measure before change; retain updates for active work, explicit read refresh and existing mutation invalidation. | No execution/budget changes; medium freshness risk; active/terminal/retry behavior and comparable request counts. 4H-C.                                          |
| 4H-005 / P2   | Low-contrast metadata on signin footer and activity timestamps. Inspect computed text/background in final browser.                              | Source uses slate-400 (#94a3b8); calculated white contrast is 2.56:1, below 4.5 for normal text.                  | Use existing semantic muted token only for measured failing combinations.                                        | No brand redesign; low color risk; rendered measurement plus token tests. 4H-A/B.                                                                                |
| 4H-006 / P2   | Different routes have the same browser title, making tab/history orientation difficult. Visit actual routes and inspect title.                  | Root metadata is the sole title declaration found: CodeLens Enterprise.                                           | Bounded route-aware page naming; never include share token, source or private identifiers.                       | Privacy-sensitive title content; medium risk; route/title tests and browser transitions. 4H-A.                                                                   |
| 4H-007 / P3   | Root loading is visual but not exposed as a status. Inspect `/` while session recovery is pending.                                              | `app/page.tsx` loading div lacks role/status; existing LoadingRegion already supplies one.                        | Reuse named loading primitive without changing redirect/session semantics.                                       | Low markup risk; semantic test and delayed read rendering. 4H-A.                                                                                                 |

No measured performance optimization, page-overflow defect, lost-focus race,
shared-reader access defect or P0/P1 vulnerability is asserted from static guesses.
Possible resize-hidden mobile focus, long audit actions, 320px dialogs and large
diff/list stalls remain **investigation candidates**, not confirmed findings.

## Proposed Bounded Slices

### 4H-A: Shared UX, Authentication Presentation and State Truthfulness

Scope candidates: app-shell, app layout, signin/root loading, activity-panel,
existing primitives only where needed, safe route titles, focused frontend tests
and this cumulative report. Confirm 4H-001/002/003/006/007 before fixes. Record
cross-route baseline, keyboard, auth/session and all nine widths. No provider,
backend, schema, role or cookie change. No generic design-system rewrite.

### 4H-B: Review Accessibility and Responsive Containment

Only browser-proven issues in diff/navigation/context/candidate/decision/shared
read surfaces, their styles, existing primitives/tokens and focused tests. Test
1920/1440/1280/1100/800/768/390/360/320 plus representative intermediate widths.
Measure contrast, zoom/reflow, focus and reduced motion. Preserve exact mappings,
lineage, stale/provenance states and deliberate mutation controls. No new routes,
contracts, tab system, brand or hidden core functionality. Exact file list follows
the completed discovery matrix, not an upfront blanket refactor authorization.

### 4H-C: Measured Polling, Large Data and Final Regression

Measure terminal/active request counts, deterministic list/diff/conversation/log
render cost, route bundle sizes, navigation/interaction proxies and CLS where
available. Fix only evidenced hotspots; no invented server pagination or arbitrary
virtualization dependency. Then run complete frontend/workspace tests, sequential
typecheck, production builds, Prisma validation/generation, scoped formatting,
debt comparison, all-route/width browser regression and final adversarial review.
No claim of field performance, Core Web Vitals pass or full WCAG compliance.

Approval of the slice plan is requested before expanding product implementation.
Runtime and synthetic-read approvals are separate from this plan.

## Proposed Runtime and Pending Authorization

No resource has been created. Docker read-only inventory succeeds with host
access; sandbox access alone returned a Docker pipe permission error. Existing
resources were listed, not started/stopped/changed. Planned identities were not
present; no listener was observed on the four planned ports.

- Project: `codelens_phase4h_quality_20261010`.
- Containers: project-prefixed `postgres-1`, `redis-1`, `api-1`.
- Networks: project `_default` internal and `_loopback` for loopback ingress.
- Database/user: `codelens_4h_quality`; PostgreSQL/Redis tmpfs, no named volumes.
- Loopback ports: PostgreSQL 56481, Redis 56381, API 55481, production Next 53481.
- New API image tag: `codelens-phase4h-quality-20261010:api`.
- Workers/brokers/ML absent; external keys absent; ephemeral local session keys.
- Once approved: ordinary fresh migrations/demo seed, then only real demo
  signin/refresh/logout and product GETs. Recheck names/ports immediately before use.
- Separately requested: synthetic GET-only states for absent recorded data,
  errors/loading and stress; never auth fixtures, writes or successful POST simulation.
- Shared-reader success fixtures must intercept requests before the real API
  because actual public reads increment view/audit state. No real token creation.
- Cleanup only owned project resources, image tag and runtime processes; verify
  no owned ports/listeners remain and all prior container/volume identities survive.
- Proof/config/screenshots remain ignored/outside Git, never production imports.

## Quality Traceability and Current Evidence

| Requirement                               | Status      | Current evidence / next gate                                                      |
| ----------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| Baseline, migration/audit integrity       | VERIFIED    | Exact HEAD/status and byte-buffer migration comparison; hashes below              |
| Route/component inventory                 | PARTIAL     | All actual routes and component families mapped; per-state runtime audit pending  |
| Functional navigation and broken links    | PARTIAL     | Source reachability only; browser matrix pending                                  |
| Accessibility, keyboard/focus and dialogs | PARTIAL     | Existing primitives/source inspected; no new browser or screen-reader pass        |
| Contrast                                  | PARTIAL     | Source calculation 2.56:1; actual rendered combinations not measured              |
| Responsive/mobile/reflow                  | NOT STARTED | Nine widths and intermediate/zoom checks pending authorized runtime               |
| Loading/empty/error and form validation   | PARTIAL     | Source-confirmed defects above; no correction yet                                 |
| Performance and large-data usability      | NOT STARTED | No baseline build/field metrics or optimization claim                             |
| Authentication UX                         | PARTIAL     | Existing real session semantics inspected; runtime approval pending               |
| Sharing and sensitive UI                  | PARTIAL     | Existing contract preserved; synthetic reader approval pending                    |
| Secret/privacy handling                   | PARTIAL     | No external credentials loaded or calls made; not universal leakage certification |
| Public-site/legal/security roadmap        | NOT STARTED | Phase 5; not invented as existing routes                                          |
| Production reliability/launch             | NOT STARTED | Phase 6; no upgraded readiness claim                                              |

Current Phase 4H checks: baseline/hash comparison PASS; deterministic 21st scan
completed; read-only Docker inventory PASS; tool availability inspected.
Frontend/workspace tests, builds, Prisma commands, scoped formatting and browser
regressions have **not been rerun in Phase 4H**. Historical 255 frontend, hosted
914 passed/14 skipped and 135 formatting failures remain prior evidence, not new
measurements. No Python files changed; Ruff has not been rerun.

## Integrity and Preserved Limitations

All 12 migration SQL files and lock compare byte-identically to starting HEAD.

- Baseline: `e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.
- Diff provenance: `883415a0f00d3001f9fa5e71f832a38aba7916b7d2e55a07a143c4be00cdf698`.
- Lock: `da12fa8151832c7297598b1504d698d41d7b1f6331b5bb7f458e8725356ba9c8`.
- Protected untracked 4A audit: `a64f828808d5eb3dd5fb72e3179432f6af7b2c03e414b9bca0e877343c98d08c`.

Known 91/CRITICAL vs unchanged 78/HIGH walkthrough drift, existing formatting/Ruff
debt, expected authentication diagnostics and prior clipping limits are retained.
Phase 3C deterministic verification PASSED; real Gemini investigation/tool/evidence
PARTIALLY VERIFIED; final grounded response/citations and multi-turn NOT VERIFIED.
Real-provider AI re-review remains NOT VERIFIED. No new provider evidence claimed.

Phase 4I logo/font/palette/motion/brand work is excluded. Phase 5 retains team,
GitHub/security/secrets/privacy/legal/public-site work. Phase 6 retains production
infrastructure, backup/recovery, load/security/reliability and controlled launch.
Any actual exposure/authorization/dangerous-mutation finding is a stop gate now,
not a reason to postpone security to a later phase.

Recommendation: approve bounded 4H-A/B/C progression and the separate runtime/read
fixture plans. No product fix, final freeze, commit, push or Phase 4I work yet.

## Phase 4H-A Implementation and Verification

The discovery sections above are preserved as the earlier source-audit snapshot,
not as the current runtime result. The subsequent authorization approved only
4H-A and its disposable runtime. This section does not upgrade 4H-B/C or the
application-wide quality matrix.

**Status: `4H_A_READY_TO_FREEZE`.** No commit or push. Starting and final HEAD:
`f5f22b54391ec5790530038681eed285884bfa46`.

### Confirmed Corrections

| Finding               | Root cause                                                                        | Scoped correction / proof                                                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4H-001                | Every audit query error previously implied insufficient permissions               | 403 retains role guidance; 401 gives session guidance; transport, 5xx and unknown failures have distinct safe messages. Only appropriate failures offer the existing GET refetch. No new polling. Real developer 403 and synthetic GET error/recovery verified.         |
| 4H-002                | Inline field errors had no input association                                      | Shared sign-in field rendering assigns stable `signin-email-errors` / `signin-password-errors` IDs and conditional `aria-describedby` / `aria-invalid`. Existing types, required fields, autofill, no-name native-submit safeguard and authentication calls preserved.  |
| 4H-003                | App layout discarded the sign-out promise and the shell had no rejection handling | Shell awaits the actual provider callback, guards concurrent activation, displays busy/disabled state, catches rejection and reports that sign-out is not confirmed. No fabricated success or revocation. Provider/cookie/session invalidation order remains unchanged. |
| 4H-005, limited scope | Confirmed slate-400 foreground on actual light backgrounds                        | Only sign-in API footer and activity timestamps use the existing semantic `text-content-muted` token. Measurements below.                                                                                                                                               |
| 4H-006                | Routes inherited the same generic title                                           | Fixed server App Router metadata layouts provide privacy-safe titles; root defines the existing product fallback/template. No token, user, PR/repository identifier, SHA or source-derived title. No client title effects.                                              |
| 4H-007                | Root loading indicator lacked status semantics                                    | Existing `LoadingRegion` exposes one named status with busy state; authenticated/anonymous redirects are unchanged. Real delayed-but-unmodified refresh verified the root announcement.                                                                                 |

No broader contrast, workspace redesign, branding or polling change was made.
4H-B/C findings remain deferred. No new dismissed defect: the discovery's
dismissed source-only wrapping hypothesis remains dismissed.

### Exact Proposed Inventory

Six modified and eleven added files, **17 files total**. The protected untracked
4A audit is not part of this inventory.

Modified:

- `apps/web/src/app/(app)/layout.tsx`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/page.tsx`
- `apps/web/src/app/signin/page.tsx`
- `apps/web/src/components/app-shell.tsx`
- `apps/web/src/components/workspace/activity-panel.tsx`

Added:

- `apps/web/src/app/(app)/activity/layout.tsx`
- `apps/web/src/app/(app)/dashboard/layout.tsx`
- `apps/web/src/app/(app)/pull-requests/layout.tsx`
- `apps/web/src/app/(app)/repositories/layout.tsx`
- `apps/web/src/app/(app)/reviews/layout.tsx`
- `apps/web/src/app/auth/callback/layout.tsx`
- `apps/web/src/app/shared/layout.tsx`
- `apps/web/src/app/signin/layout.tsx`
- `apps/web/src/components/signin-field.tsx`
- `apps/web/test/application-state.test.tsx`
- `docs/phase4h-product-quality-accessibility-performance.md` (intentional discovery addition, preserved and extended)

### Executed Verification

- Frontend suite: **268 passed, 0 failed, 0 skipped**, including 13 new regression
  cases. Cases cover error categories, safe retry busy state, escaped/associated
  field errors, fixed metadata, root announcement and semantic contrast classes.
- Isolated mocked-function browser component harness: **13 assertions passed**.
  Double activation calls sign-out once; pending is disabled/busy; rejection is
  caught and safely announced; location is unchanged; deliberate keyboard retry
  works; resolved handlers do not invent logout claims. Field descriptions and
  retry callbacks are exercised. This does not mock real authentication or HTTP
  success, and remains ignored local proof rather than a new default test runner.
- Sequential workspace typecheck: **passed**, using
  `pnpm -r --workspace-concurrency=1 --if-present typecheck`.
- Final production Next build: **passed**, including its type validity check.
  Final tested build ID: `1kIzjEvi-IRekiBKOY0DF`.
- Fresh isolated database initialization: **all 12 migrations deployed** through
  the normal initializer, then the explicitly authorized normal demo seed.
  No schema/source migration edits or synthetic product database writes.
- API Docker build succeeded using cached existing API/package layers. This is
  runtime setup evidence, not a claim that backend/package regression suites or
  builds executed anew. No backend/shared-contract source changes required those
  suites; full workspace tests and Ruff were not rerun in 4H-A.
- Deterministic 21st source review rerun: 69 files, 0 errors, 7 warnings,
  81 suggestions. This is a heuristic scan, not accessibility certification.
- `git diff --check`: passed. No staging, commit or push.

### Production Browser Matrix

**118 assertions passed** against the final production build at widths
**1920, 1440, 1280, 1100, 800, 768, 390, 360, 320**.

Sign-in, Reviews/dashboard, Repositories, Activity and Review workspace were
checked across all nine widths for relevant titles and document containment.
The seeded review remains genuinely UNVERIFIED; no diff provenance is fabricated.
Legacy pull-request redirect, OAuth recovery (without OAuth execution), canonical
shared reader and historical share redirect were also checked for correct titles.
Screenshots inspected at 320 pixels confirm sign-in and activity composition;
1920/320 route screenshots remain outside Git.

Real proof uses documented owner/developer credentials and the real API:
invalid login, keyboard manual login, cookie refresh on reload, successful logout,
post-logout protected-route redirect and developer activity denial. GitHub's
sign-in button remains independently named/visible, but GitHub OAuth is not
executed or reverified here. Keyboard Tab exposes the existing 2px focus outline;
at 390/360/320 the menu focuses the navigation link and Escape restores the
visibly focused opener. This is not a screen-reader or exhaustive keyboard audit.

SYNTHETIC proof is restricted to GET responses: activity 403, transport failure,
500 and unknown/422 categories; keyboard retry then reads real audit data.
Shared-reader errors are intercepted before the real public API to avoid share
view/audit writes. No real share is created/read. Sign-out failure is separately
tested through the mocked-function component harness, not auth endpoint mocks.

Initial harness attempts exposed timing/selector problems: programmatic focus
while the submit button was pending, overly rapid refresh-heavy navigation, and
an incorrect expected shared-reader label. Aggregate isolated API diagnostics
confirmed throttle events. The harness now waits for settled real navigation,
paces refresh requests at 2.1 seconds and uses actual visible labels. No auth
policy was changed or bypassed. Abrupt navigation during in-flight cookie
rotation is not independently certified by this successful settled-flow proof.

### Contrast Measurements

Measured computed foreground against the first rendered nontransparent ancestor
background, using relative luminance. Both inspected elements have opaque solid
backgrounds; the primitive/token palette was not redesigned.

| Element            | Before foreground/background        | Before | After foreground/background      | After  |
| ------------------ | ----------------------------------- | ------ | -------------------------------- | ------ |
| Sign-in API footer | rgb(148,163,184) / rgb(250,250,250) | 2.46:1 | rgb(82,82,91) / rgb(250,250,250) | 7.41:1 |
| Activity timestamp | rgb(148,163,184) / rgb(255,255,255) | 2.56:1 | rgb(82,82,91) / rgb(255,255,255) | 7.73:1 |

Baseline measured build: `1qEvGPagAJbgX-e3IrJlM`. After measurements use the final
tested build `1kIzjEvi-IRekiBKOY0DF`. These results establish only these two rendered
combinations, not whole-product contrast compliance.

### Network, Privacy and Mutation Boundary

The completed browser-run method/path/source **API audit** recorded:

- REAL auth: 67 refresh POSTs, 3 sign-in POSTs (one invalid, owner and developer),
  2 sign-out POSTs, 55 session GETs.
- REAL non-auth GETs (including health): 147; SYNTHETIC product GETs: 10.
- Forbidden operation/external-origin attempts: **0**; browser runtime exceptions:
  **0**. The origin guard covered all browser traffic; product writes were denied
  by the API request guard. No provider or GitHub execution occurred.

Only method, sanitized path and source are recorded, never headers, bodies,
tokens or passwords. Share-path parameters are redacted. Checked diagnostics
remain visible and classified: expected 401, real/synthetic 403, synthetic 404,
500/422, failed transport and navigation-aborted requests. They are not suppressed
or represented as error-free console output.

All **49 product-table fingerprints remained identical** before/after browser
proof. User, Account and AuditLog are excluded from that comparison because
normal authorized authentication/session activity may alter them. No synthetic
conversation/evidence/provenance/execution data is persisted. No consequential
product mutation, provider call or GitHub write is performed.

### Disposable Resource Cleanup

- Project: `codelens_phase4h_quality_20261010`.
- Containers: `codelens_phase4h_quality_20261010-postgres-1`,
  `codelens_phase4h_quality_20261010-redis-1`,
  `codelens_phase4h_quality_20261010-api-1`.
- Networks: project `_default` and `_loopback`.
- Database/user: `codelens_4h_quality`; confirmed tmpfs paths
  `/var/lib/postgresql/data` and `/data`; no named data volumes.
- Loopback ports: PostgreSQL 56481, Redis 56381, API 55481, Next 53481.
- Owned API image: `codelens-phase4h-quality-20261010:api`, removed after use.
  Workers, brokers and ML absent; external integration credential values absent.

All owned containers/networks/tmpfs data and image tag removed. Next process
stopped and component HTTP server closed. No listeners remain on the four
approved ports or final component port 56374. Prior container/volume identities
were compared with the pre-start inventory and retained. No previously certified
resource was started, changed, reused or removed.

Ignored `.codelens-tmp/phase4h-a/` proof/config/JSON drivers remain local only;
screenshots are under the external visualization root. None is production code
or proposed for Git. Common credential-pattern checks of proposed source/report
files found no matches; this is a scoped check, not universal leak certification.

### Freeze Integrity and Remaining Boundaries

All 12 migration SQL files and lock remain byte-identical to starting HEAD.
The four required hashes remain exactly as recorded in the preceding Integrity
section, including the protected untracked 4A audit. Backend, dependencies,
providers, CI, cookie/security policy and shared contracts are unchanged.

Tracked formatting debt: **135 before / 135 after**, with the same failing set.
All added files pass Prettier; no new tracked failure. Scoped CLI check reports
only the pre-existing sign-in page debt; it is deliberately not mass-formatted.
Ruff debt is unchanged by source (no Python edits); Ruff was not rerun.

Adversarial review found no auth bypass, fabricated sign-out success, raw error
leak in new recovery text, unsafe source rendering, client title effect, token
title, new polling, synthetic production fixture, execution trigger or later-phase
implementation. Production builds and tests exercise the new boundaries without
altering the original provider's invalidate-after-success ordering.

Not established: WCAG compliance, screen-reader output, exhaustive accessibility,
all browser/platform behavior, broad workspace contrast/reflow, performance
optimization, interrupted refresh-rotation recovery or production readiness.
Known risk-score walkthrough drift, clipping limitations, formatting/Ruff debt
and Phase 3C/provider limitations above remain disclosed and untouched.

Proposed commit subject: `fix(web): improve authentication and application UX`.
Stop before commit/push; do not start 4H-B, 4H-C or 4I.

## Phase 4H-B: Accessibility and Responsive Containment

This section records new 4H-B work, not a reinterpretation of the historical
discovery or 4H-A results above. Starting HEAD is
`2a759e9b1cd4f608c6d04c50dfe3546d0200ef89`; its existing hosted CI run is
[38032997240](https://github.com/abhi02max/CodeLensEnterprise/actions/runs/38032997240).
That run certifies the starting revision, not this uncommitted changeset.
The starting tracked tree was clean; only the protected untracked 4A audit was
present. No commit, push or later-phase implementation is authorized here.

### Verified Defects and Bounded Corrections

| ID / severity | Reproduction and actual browser evidence                                                                                                                                                     | Root cause / exact correction                                                                                                                                                                                                                  | Regression evidence                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4HB-001 / P2  | Open Selection context at 800px, widen to 1440px so the opener disappears, then close the drawer. Before: active element becomes BODY.                                                       | The connected opener was focused even when hidden by the breakpoint. Restore focus only to a connected element with a rendered rectangle; otherwise use the existing named PR changes region. No selection or provenance change.               | Final production browser restores focus to the visible changes region; four focused tests cover visible, hidden, disconnected and absent targets. This is not a universal visibility detector.                                 |
| 4HB-002 / P2  | At 320x450, the diff reading region was 11px high and started below the viewport; at 640x450 and 960x450 it was 108px and 181px.                                                             | Fixed workspace height minus stacked controls collapsed its inner flex region. Only below 600px viewport height, use document reflow with bounded inner scrolling and a 200px minimum reading region. Normal 900px-high layouts are unchanged. | Final reading heights are 200px at all three sizes. Focus scrolls the narrow reading region into view; document containment and primary-action checks pass.                                                                    |
| 4HB-003 / P2  | Real seeded Analysis contains pale policy/disclosure, risk denominator, context symbol/target and pipeline sequence/timing metadata. Discussion also has pale comment-kind/timestamp labels. | These observed elements used slate-400 on a light background. Replace only those classes with the existing semantic muted token. No palette redesign, missing-state edit or risk/data change.                                                  | 33 matched rendered Analysis samples improve from 2.56:1 to 7.73:1 on white. Discussion uses the same token but is not counted in that 33-sample comparison. Two focused rendering tests preserve source/score/status meaning. |

No broad rewrite or 4H-B1/B2 split was needed for these three bounded groups.
Source-only wrapping guesses were not promoted into defects. Native dialog
behavior was retained; no custom focus trap or auth behavior was introduced.

### Exact Proposed Inventory

Eight modified files and one added test, **nine files total**:

- `apps/web/src/components/workspace/review-workspace.tsx`
- `apps/web/src/components/workspace/review-workspace.css`
- `apps/web/src/components/workspace/ai-review-panel.tsx`
- `apps/web/src/components/workspace/comments-panel.tsx`
- `apps/web/src/components/workspace/context-panel.tsx`
- `apps/web/src/components/workspace/risk-panel.tsx`
- `apps/web/src/components/workspace/tool-runs-panel.tsx`
- `apps/web/test/workspace-accessibility.test.tsx` (added)
- `docs/phase4h-product-quality-accessibility-performance.md`

Backend, auth, shared contracts, dependencies, CI, providers, migrations and
execution/polling handlers are untouched. Test-only React runtime adaptation is
confined to the new node:test file and restored after its rendering tests.
No synthetic identity or response fixture is embedded in production code.

### New Automated and Build Evidence

- Focused tests: **6 passed**, covering drawer focus fallback and contrast
  metadata rendering without changing recorded source, score or status.
- Full frontend tests: **274 passed, 0 failed, 0 skipped**; baseline was 268.
- Workspace tests: **907 passed, 21 skipped**, executed anew via `pnpm test`.
  The root command excludes the separately executed frontend suite; totals
  are not represented as coverage percentages or combined duplicate counts.
- Sequential workspace typecheck: **passed** via
  `pnpm -r --workspace-concurrency=1 --if-present typecheck`.
- Final production Next build: **passed**. Tested build ID:
  `EmUFASPb01rrLC1dir4Kb`. Baseline measured build:
  `iXtnxQmq1OE7o3WBYX5Ms`.
- Fresh isolated normal database initialization deployed **all 12 migrations**,
  verified RAG infrastructure and then ran the documented authorized demo seed.
  The cached existing API Docker build passed as runtime setup; no backend
  source change or new backend capability is implied.
- Deterministic source scanner: **69 files, 0 errors, 7 warnings, 81 suggestions**,
  unchanged in disposition. It is not an automated WCAG audit.

### Production Browser Matrix and Evidence Boundary

Final-build containment audit: **202 assertions passed**, **97 layout
observations**. Separate conversation/evidence regression: **17 assertions
passed**. Candidate/reflow/contrast drill records measurements separately rather
than counting each measurement as a passed browser assertion.

| Surface                                                  | Actual widths / states checked                                                                       | Evidence source and boundary                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in, dashboard, repositories, activity, review modes | 1920, 1440, 1280, 1100, 800, 768, 390, 360, 320; Changes, Discussion, Candidates, Analysis, Decision | Real seeded API and real authentication. Seeded diff remains UNVERIFIED; empty candidate/readback states are not invented.                                                                                                                                          |
| Long verified diff, files/findings and drawers           | All nine widths plus 1439, 1024, 1023, 767, 480, 640                                                 | SYNTHETIC GET-only contract-compatible diff; intentional inner horizontal code scrolling remains distinct from document overflow. Escape, focus return, resize-hidden opener and primary action bounds checked.                                                     |
| Conversation, evidence and source mapping                | Focused selection/revision checks                                                                    | SYNTHETIC GET-only; exact HEAD evidence maps to NEW line 12, finding line 11 remains selected, revision B invalidates the old highlight. Historical mismatch and explicit valid-context reselection are checked. No conversation/tool execution or database writes. |
| Candidate evaluation and paired check tables             | All nine widths                                                                                      | SYNTHETIC GET-only selected candidate/readback. Long code stays in its own region; file controls have visible 2px focus outlines. No materialization, validation or provider execution.                                                                             |
| Shared reader                                            | All nine widths for long-title FULL/no-analysis view; intercepted unavailable/passphrase states      | SYNTHETIC GET-only intercepted before public API; no real share access, view counter or share audit mutation. Existing payload allowlist remains unchanged.                                                                                                         |
| Short-height reflow                                      | 960x450, 640x450, 320x450                                                                            | Half-size CSS viewport checks represent 200%-style layout reflow. They are not an actual browser zoom-control or assistive-technology certification.                                                                                                                |
| Reduced motion                                           | Computed existing spinner/transition rules                                                           | Under reduced-motion preference, inspected animation/transition behavior is disabled. No decorative motion or global motion redesign added.                                                                                                                         |

Accessible names, status semantics and landmarks were inspected on exercised
controls. Keyboard checks cover file/finding/context selection, code-region
focus, drawer Escape/restoration and narrow navigation. Decision preview tests
do not activate its submit action. Color-independent provenance labels remain
VERIFIED / UNVERIFIED / PARTIAL / UNAVAILABLE; no source anchors, full-file
contents or revision authority are fabricated by a product change.

### Screenshots and Measurement Limits

Screenshots remain outside Git under the visualization root in `phase4h-b`,
`phase4h-b-context` and `phase4h-b-auth`. The initial real decision screenshot
and final short-height 320px screenshot were visually inspected. Baseline and
final dimensions/focus/contrast are recorded separately in ignored JSON.
The synthetic diff screenshot filenames were reused on the final run; they
are not retained paired before/after image evidence. No baseline short-height
screenshot was retained, so the numerical comparison is not represented as
a paired image comparison.

Contrast uses computed opaque foreground/background and relative luminance:
`rgb(148,163,184)` on white, **2.564:1**, becomes `rgb(82,82,91)` on white,
**7.730:1**, for the 33 matched Analysis samples. No claim is made for every
color, opacity, disabled state, edited-comment label or unrendered metadata.

At 320px the Analysis support scroller still has a measured 330px internal
scroll width, including intentionally scrollable/truncated content. The document
and tested primary controls remain contained. Its full cause and all historical
clipping observations are not declared resolved by this narrow changeset.

### Authentication Harness and Diagnostic Disposition

Authentication remains real: no endpoint, cookie, identity, membership, role or
authorization mock. Root pending state uses a bounded artificial response delay
without replacing its response. An extended regression attempt passed 37 checks
before navigation failed with a suspended request; the isolated API recorded no
throttling on that attempt. A faster retry passed 74 checks before the API
returned 429. The test had delayed every refresh response instead of only the
initial loading check. Final harness navigation is paced before requests to
respect the unchanged rate limit; no production auth policy is modified.
Interrupted refresh recovery is not newly certified. Expected 401 and synthetic
error diagnostics are retained, not hidden or counted as runtime exceptions.

### Security, Cleanup and Freeze Gate

**4H_B_READY_TO_FREEZE** for the bounded corrections and tested states above.
Stop before commit/push; do not start 4H-C or 4I.

Final real-auth/dialog regression: **163 assertions passed** against the same
final production build. Nine-width decision previews place initial focus on
Cancel, Tab reaches Confirm without activating it, and Escape restores the
opener. History and empty share metadata remain truthful. Invalid credential
login, manual keyboard login, cookie refresh, logout, protected routes and real
developer activity denial pass. The independent GitHub control remains visible;
no OAuth request executes. Total separately recorded final browser assertions:
**202 + 17 + 163 = 382**, excluding measurement-only drills.

The final authentication run recorded **284 API requests**: 67 real refresh POSTs,
3 real sign-in POSTs (invalid, owner, developer), 2 real sign-out POSTs, 55 real
session GETs, 147 other real product/health GETs and 10 synthetic product GETs.
The containment audit separately recorded 335 API requests, and the drill 125.
Conversation fixture logs include interception/fallback observations; those
are not summed as unique network requests. All completed drivers recorded zero
forbidden operations and zero browser runtime exceptions. Expected 401, 403,
404, synthetic transport/500/422 and navigation-aborted diagnostics remain
visible. The earlier failed attempts remain disclosed above.

Only approved initialization/seed and ordinary authentication/session activity
write to the isolated runtime. All **49 product-table fingerprints remain
identical** before/after browser work; User, Account and AuditLog are excluded
because authentication/session activity can change them. No synthetic product
records are written. No analysis, investigation, RAG indexing, comment,
conversation, proposal, candidate, validation, ML/AI reassessment, verdict,
share creation, provider or GitHub operation is invoked. Public share GETs are
intercepted before the API. Request logs contain method, sanitized path and
source only, not bodies, headers or credentials.

Fresh disposable resources, all removed:

- Project: `codelens_phase4hb_accessibility_20261010`.
- Containers: project `-postgres-1`, `-redis-1`, `-api-1`.
- Networks: project `_default` and `_loopback`.
- Database/user: `codelens_4hb`; PostgreSQL `/var/lib/postgresql/data` and Redis
  `/data` use tmpfs; no named data volume is created.
- Loopback ports: PostgreSQL 56482, Redis 56382, API 55482, Next 53482.
- Unique API image: `codelens-phase4hb-accessibility-20261010:api`, removed.

Workers/brokers/ML are absent, and external integration credentials are absent.
All owned containers, networks, temporary database data and runtime/browser
processes are removed; all four ports have zero listeners. Prior container and
volume identities remain present. No previous certified resource is reused,
started, modified or removed. Ignored `.codelens-tmp/phase4h-b/` drivers/config/
JSON and external screenshots remain local only, excluded from Git and Docker
images by the existing rules.

All 12 migrations and lock remain byte-identical to starting HEAD, with the
required baseline/diff/lock/audit hashes unchanged. The 4A audit remains untracked
and untouched. The report's entire historical prefix is preserved. No file is
staged; the nine-file inventory is the complete proposed changeset.

`git diff --check` and scoped formatting/integrity checks pass subject to existing
debt. Tracked Prettier is **135 baseline / 135 current**, identical failing set,
no new failure. Three touched files already have formatting debt:
`ai-review-panel.tsx`, `risk-panel.tsx`, `comments-panel.tsx`; they are not
mass-formatted. Other touched files and the added test pass scoped formatting.
No Python changes; Ruff is not rerun and its known debt remains disclosed.
Scoped credential-value patterns find zero matches in the nine proposed files;
this is not universal leak certification.

Final adversarial review finds no repository writes, unsafe source rendering,
new request/polling/execution trigger, authorization change, synthetic production
fixture, cross-candidate evidence change, fabricated provenance, acceptance
change, share exposure, provider budget change or later-phase implementation.
Focus fallback is limited to existing rendered regions, CSS reflow is confined
to short viewports, and semantic-color edits do not modify recorded data.

Proposed commit subject: `fix(web): improve workspace focus reflow and contrast`.

Known risk-score drift, existing formatting/Ruff debt, historical clipping and
Phase 3C/provider limitations above remain unchanged. Formal WCAG compliance,
screen-reader output, exhaustive accessibility, all browsers/platforms, actual
zoom-control behavior, live provider/remote freshness and production readiness
are not established. Performance/stress optimization remains deferred to 4H-C;
final release/exact-revision certification remains deferred to Phase 4I.
