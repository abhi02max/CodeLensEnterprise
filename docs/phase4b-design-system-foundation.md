# Phase 4B: Design System Foundation

## Freeze Scope

Starting and final HEAD: `0536a642cdbd50ce52f69c1700612c95e6ea11e4`.
This is an uncommitted foundation, not a page redesign or a release certification.
The authoritative Phase 4A audit was read and left unchanged. It was already
untracked before this work and is not part of the proposed Phase 4B inventory.

Exactly seven files are proposed:

| File                                        | Responsibility                                                   |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `apps/web/src/app/globals.css`              | Semantic CSS tokens, focus, reduced motion                       |
| `apps/web/tailwind.config.ts`               | Token exposure, typography, spacing, geometry                    |
| `apps/web/src/components/ui/primitives.tsx` | Shared native presentation primitives                            |
| `apps/web/src/lib/cn.ts`                    | Merge compatibility for custom typography/spacing/radius/density |
| `apps/web/src/components/risk.tsx`          | Small representative status/severity consumer                    |
| `apps/web/test/design-system.test.tsx`      | Focused deterministic contracts and contrast checks              |
| `docs/phase4b-design-system-foundation.md`  | This implementation/evidence record                              |

No page, route, package manifest, lockfile, API, database schema, migration,
provider, authorization, or domain implementation was changed. No dependencies
or fonts were added. Existing Tailwind, CVA, Lucide and native controls remain.
Phase 4A's restrained technical direction remains authoritative; no external
component code was imported and no decorative AI identity was introduced.

## Token Architecture

CSS properties named `--cl-*` provide semantic RGB triples. Tailwind exposes
them as `rgb(var(--cl-ROLE) / <alpha-value>)`, preserving opacity utilities.
Geometry uses length-valued properties. This is light mode only; the existing
Tailwind dark-mode setting is retained but no dark theme was implemented.

| Role                  | Tailwind mapping                                                                               | Intent                                            |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Canvas                | `canvas`                                                                                       | Neutral page background                           |
| Surface               | `surface`, `surface-subtle`, `surface-muted`, `surface-raised`                                 | Content/grouping/layering                         |
| Selected surface      | `surface-selected`, `selected`, `selected-hover`, `selected-text`                              | Teal selection; not success, severity or focus    |
| Text                  | `content-primary`, `content-secondary`, `content-muted`, `content-disabled`, `content-inverse` | Content hierarchy; not domain confidence          |
| Structure             | `structure`, `structure-strong`, `structure-divider`                                           | Ordinary border, control boundary, divider        |
| Interaction           | `interactive`, `interactive-hover`                                                             | Charcoal command surfaces                         |
| Focus                 | `focus`                                                                                        | Blue keyboard outline                             |
| Status                | `state-{success,warning,danger,info,unavailable,uncertain}-{text,bg,border}`                   | Explicit textual execution/context state          |
| Solid status controls | `state-{success,danger}-{solid,hover}`                                                         | Existing approve/reject variants, not new actions |
| Severity              | `severity-{critical,high,medium,low}-{text,bg,border}`                                         | Finding severity, separate from execution status  |
| Diff                  | `diff-{add-bg,add-text,delete-bg,delete-text,modified,selected,line-number,border}`            | Foundation only; no PR diff implementation        |

Existing `surface-border` and `risk-*` aliases remain for compatibility. Risk
LOW retains its existing green association; severity LOW is neutral. Neither
means safe. Warning/uncertain and some severity/status colors share a palette
but remain distinct token namespaces and textual meanings. No semantic enum,
data score, decision, confidence or authority was inferred from a color.

`StatusLabel` accepts an explicit label, tone and optional context. It does not
map domain state by itself. `RunStatusBadge` is the representative consumer:
COMPLETED and RUNNING use informational text, PARTIAL warning, FAILED danger,
UNAVAILABLE neutral unavailable, UNCERTAIN uncertain. COMPLETED is not presented
as SAFE. `SeverityBadge` delegates to the separate `SeverityLabel`; severity
order and labels remain unchanged. Risk scores and RiskMeter calculations remain
unchanged, including the known seeded 78/HIGH versus walkthrough 91/CRITICAL drift.

## Typography, Geometry And Composition

The existing system sans and monospace stacks remain. No viewport-scaled type or
negative tracking was introduced. New semantic sizes are in rem:

| Utility         | Nominal size / line height |
| --------------- | -------------------------- |
| `text-page`     | 24 / 30                    |
| `text-section`  | 18 / 26                    |
| `text-panel`    | 14 / 20                    |
| `text-body`     | 14 / 22                    |
| `text-compact`  | 13 / 20                    |
| `text-metadata` | 12 / 18                    |
| `text-label`    | 13 / 18                    |
| `text-code`     | 13 / 20                    |

Existing xs/sm/base/lg/xl sizes remain compatible. Body uses the body role.
PageHeader supplies an unframed h1; SectionHeader supplies a compact unframed
h2 suitable for existing panels. CardHeader composes SectionHeader while
preserving its h2 contract. The 18px section role is available for later page
adoption; existing page titles were not mechanically enlarged. Titles and
actions wrap rather than truncating in these shared headers.

Spacing properties represent 4/8/12/16/24/32px. Control horizontal padding is
12px; section horizontal/vertical padding is 16/12px. Existing Tailwind spacing
remains usable. Button density is opt-in: compact 36px and comfortable 44px
minimum heights. Existing small/default/large controls retain approximately
28/32/36px minimum heights, with padding and wrapping instead of fixed clipping.
This is not a user density preference system or a claim that all legacy hit
targets have been enlarged.

Controls use 4px radii, future overlays have a 6px token, existing repeated
frames use 8px. Structural sections are not automatically framed. One-pixel
borders remain; no new shadow or floating section was added. Existing page
cards were not decomposed throughout the app. Field preserves dt/dd semantics
and wraps full technical values instead of removing them with ellipses.

The class merger explicitly recognizes new font-size, spacing, radius and
density tokens. Without that configuration, `text-compact` was interpreted as
a color and removed the white primary-button label. The defect was caught in
browser verification and corrected, with tests for independent color/size
overrides, legacy utilities, spacing/radius overrides and density precedence.

## Native Controls And Feedback

- Button keeps native type, events, disabled state and loading/aria-busy behavior.
  Disabled hover styling is avoided. Consumer class overrides remain supported.
- Input/Select/Textarea preserve native attributes, labels, refs where already
  supported, validation associations and interaction behavior. Tokens normalize
  borders, padding, placeholder, disabled and aria-invalid presentation.
- A global `:focus-visible` rule uses a 2px blue outline with 2px offset rather
  than removing focus. Browser keyboard checks observed visible focus on input,
  select and proposal action surfaces. The current browser reported scaled
  1.6px outlines; that is not a claim of testing at a controlled 100% zoom.
- Spinner uses Lucide LoaderCircle at 16px, stroke 2; pending controls use 12px.
  It is decorative, aria-hidden and non-focusable. Existing consumer icons and
  icon-only accessible-name forwarding remain; no new icon-only action or tooltip
  framework was introduced. No overlay was needed, so none was implemented.
- Skeleton is a decorative block-styled span, compatible with existing inline
  loading uses. This avoids the pre-existing dashboard div-inside-p hydration
  warning. A fresh dashboard tab emitted no warning/error after the correction;
  the earlier captured diagnostic was not suppressed or erased.
- LoadingRegion offers a named status and aria-busy region, without fake progress.
  Pages were not all migrated to it.
- EmptyState keeps the existing primary action and adds an optional secondary
  action; it is compact and textual, with wrapped explanation/action rows.
- Alert preserves assertive danger/error versus polite information, warning and
  success roles. Errors are not automatically converted to transient toasts.
- `prefers-reduced-motion: reduce` disables spin/pulse animation and color/all
  transitions. CSS presence was tested; OS preference emulation was not performed.

## Browser Evidence

The original CodeLens and C2 stacks were not changed. Existing stopped
`codelens_phase3g_human_loop_20261005` PostgreSQL/Redis/ML/API containers were
identified by Compose labels and safely restored. The PostgreSQL volume remained
`codelens_phase3g_human_loop_20261005_postgres_data`. Workers/provider/brokers
were not started. The existing isolated API disallows workers-in-API and uses
its previously reviewed external-call-blocking preload. No seed, analysis,
investigation, validation, reassessment or provider operation was triggered.

Current frontend source was served locally on port 53410 against the existing
isolated API on 55410. Only existing read surfaces were opened. Manual demo login,
invalid login, session restoration and logout naturally affect authentication
session/audit state; no review decisions, comments, conversations, candidates,
shares or RAG data were changed. GitHub sign-in was independently discoverable
but not invoked. No provider/GitHub credentials were loaded for verification.
Temporary frontend processes were stopped after inspection; the restored four
isolated dependency containers were left running. No local configuration file
was created or changed for this phase.

| Surface                                       | Widths inspected       | Result and remaining boundaries                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signin                                        | 1440/1280/1100/800/390 | Zero page overflow; input 32px; primary 36px with white 13px label. Invalid credentials produce truthful alert; valid manual login works. GitHub action remains separate. Keyboard focus visible.                                                                                                          |
| Dashboard                                     | 1440/1280/1100/800/390 | Zero page overflow; data/status headings render; HIGH 78 unchanged. Existing mobile recent-row truncation and nested metric frames remain.                                                                                                                                                                 |
| Repositories                                  | 1440/1280/1100/800/390 | Zero page overflow; Connect/Sync labels readable, controls intact. Not invoked. Existing mobile repository-name truncation/hidden columns remain.                                                                                                                                                          |
| Pull requests                                 | 1440/1280/1100/800/390 | Zero page overflow; native repository select remains 32px; risk/status labels and review links render. Existing responsive hidden columns/title ellipses remain.                                                                                                                                           |
| Review #447, existing human-loop conversation | 1440/1280/1100/800/390 | Zero page overflow; shared h2 labels wrap; no visible form/action extends beyond page width. Existing accepted proposal, disabled decisions, diff and persisted candidate evidence render. Edit/request-revision controls wrap on mobile; keyboard focus visible. No decision or execution action invoked. |
| Public/shared                                 | Not visited            | Public readback increments share view state; omitted to honor non-mutation constraint. No public-share verification claim.                                                                                                                                                                                 |

Screenshots were inspected at 1440/1100/390. A representative screenshot is
stored outside the repository in the permitted visualization workspace, not in
the proposed commit. No new major visual/functional regression was observed in
this sample. Page layouts, navigation horizontal scrolling, small legacy hit
areas, direct-color metadata, long review stacking and internal code overflow
remain later-phase work. Before-edit runtime was unavailable initially, so the
visual baseline is the Phase 4A audit rather than a new pixel-diff baseline.
This is not exhaustive regression or production-browser certification.

## Accessibility And Contrast

Focused tests verify color-independent state labels, native disabled/invalid
attributes, accessible-name/error-association forwarding, alert/status roles,
heading levels, wrapped header contracts, decorative loading, reduced-motion CSS
and token mappings. Browser checks verify manual form behavior, keyboard Tab
focus, disabled accepted-proposal controls and readable action labels.

Twenty-five major text/token combinations meet at least 4.5:1. Focus and control
border roles exceed 3:1 on canvas, ordinary/subtle/raised and selected surfaces.
Representative calculated ratios: primary/canvas 16.97, muted/muted-surface 7.03,
inverse/primary-button 14.89, inverse/approve-button 5.02, warning/background 6.61,
focus/white 6.70, strong-control-border/white 4.83.

These checks do not cover every remaining direct-color page utility, every
consumer opacity override, all screen readers, focus clipping everywhere,
200% browser zoom, or OS reduced-motion execution. No WCAG certification claim.
200% zoom remains a manual accessibility check for later responsive work, not
something inferred from the 390px viewport.

## Verification And Debt

Baseline web typecheck and production build passed before edits. Relevant
verification after implementation:

```powershell
node packages/database/node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json --test apps/web/test/design-system.test.tsx
pnpm test
pnpm -r --workspace-concurrency=1 --if-present typecheck
pnpm --filter @codelens/web build
pnpm --filter @codelens/database exec prisma validate
pnpm --filter @codelens/database generate
git diff --check
```

Results: focused tests 16/16; workspace tests passed (including API 457 and
AI-agent 111), with existing Docker-dependent cases skipped in that unit-suite
configuration. Sequential workspace typecheck passed, web production build
passed, Prisma validation and client generation passed, diff check passed.
The standalone frontend test command uses the already installed tsx loader;
it is not newly wired into root CI and no test framework was installed.

Sandbox runs could not read an existing installed `diff` dependency/CLI shims;
host-access reruns passed. This was not resolved with product or dependency edits.
Prisma validation used a dummy non-connecting DATABASE_URL and no SQL was run.
The frontend browser pass was manual read-only verification, not a rerun of the
state-mutating full walkthrough. Expected signin 401 diagnostics and known
walkthrough risk drift are not suppressed or fixed by this phase.

Scoped Prettier checks cover all seven proposed files. Tracked canonical
extensions (`ts/tsx/js/json/md/yml/yaml`, honoring prettierignore) had 145 failures
before edits and 143 after: the two pre-existing failures in touched primitives
and risk were removed; unrelated failing files were not formatted. New test/doc
files are checked separately because they are untracked. CSS is included in the
scoped check even though absent from the canonical extension glob.
The repository-wide raw glob remains blocked by EPERM scanning an ignored
`.codelens-tmp/phase3f-ai/pytest-temp-venv` directory; its misleading success text
after a glob error is not a pass. This tracked-file comparison is a disclosed
alternative measurement, not a claim that repository formatting passes.
No Python/Ruff files changed or Ruff-debt cleanup was attempted.

Remaining direct-color debt: a scoped textual inventory found 263 matches on
233 lines in 29 TSX source files. This counts utility-pattern matches, not unique
design defects. Remaining debt includes page layouts, health banner, tables,
collaboration/proposals/application/validation/static/ML/AI panels, public share
and callback. It is intentionally deferred rather than mass-migrated.

## Integrity And Adversarial Review

Zero migrations added or modified. All eleven migration SQL files and the lock
were hashed and compared byte-for-byte to HEAD. All matched. Baseline SHA-256:
`e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.

Diff review covers native prop compatibility, class override precedence, status
versus severity authority, wrapping/geometry, focus, safe React text rendering,
loading markup and absence of backend/domain paths. Scoped defects corrected:
semantic class merger typography/density/spacing/radius handling and Skeleton
paragraph compatibility. No test double, fixture state, credential, runtime
driver, temporary configuration, screenshot or generated evidence was added to
product source or proposed files. The scoped credential-pattern scan reports no
matches; this is not a universal secret-non-leakage claim.

No authentication/authorization/tenant, expected-head verdict, audit, candidate,
proposal, validation, ML, AI, RAG, provider, GitHub or public-share behavior changed.
No real provider call, GitHub product mutation, or RAG mutation occurred.
All Phase 3C real-provider limitations remain: investigation/tool/evidence path
partially verified; final grounded response/citations and multi-turn behavior
not verified. Phase 4B does not upgrade any earlier certification claim.

## Exit And Handoff

Phase 4B foundation exit criteria A-Q are satisfied within the disclosed sampled
verification scope. Recommendation: **READY_TO_FREEZE**, not committed or pushed.
Proposed subject: `feat(web): establish semantic design-system foundation`.

Future 4C work should consume these roles, preserve explicit state/source meaning
and native accessibility, and undertake only its separately approved page scope.
Do not treat token availability as an implemented Review Inbox, diff, ContextRail,
CandidateComparison, DecisionSummary, overlay system, dark theme or navigation
redesign. Phase 4C has not started.
