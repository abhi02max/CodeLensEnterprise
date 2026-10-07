# Phase 4C: Application Shell And Review Inbox

## Scope And Baseline

Starting and final HEAD: `7f53e4c22dd9c6e60c2b9f59f0996ae234d7076e`.
The contract prerequisite is certified by exact-SHA CI run `37486310026`.
This document records the uncommitted UI slice, not hosted certification.
Recommendation: **READY_TO_FREEZE** within the verification boundaries below.
No commit, push or Phase 4D implementation occurred.

The Phase 4A audit remains untracked and byte-identical. The Phase 4B tokens,
native controls and documented product direction are reused. The 21st CLI was
unavailable; no catalog code, UI package, font or dependency was installed.

## Routes And Shell

| Route             | Old role                   | New role / compatibility                                                                                                                         |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`               | Session resolver           | Unchanged; authenticated destination remains `/dashboard`.                                                                                       |
| `/signin`         | Credential/GitHub sign-in  | Unchanged; existing credential redirect now reaches Reviews.                                                                                     |
| `/auth/callback`  | OAuth completion           | Unchanged; retains repositories destination and safety behavior.                                                                                 |
| `/dashboard`      | Metrics and recent PRs     | Canonical Reviews inbox; metric-card primacy removed.                                                                                            |
| `/pull-requests`  | Separate PR table          | Server redirect to canonical inbox, retaining validated repository/state/risk/order/page parameters. Unknown parameters are not carried forward. |
| `/repositories`   | Repository table           | Unframed connected-source list, View reviews links and server pagination.                                                                        |
| `/reviews/[id]`   | Certified review workspace | Same source and behavior, within the new shell.                                                                                                  |
| `/activity`       | Organization admin audit   | Existing route, labeled History in navigation for ADMIN/OWNER only.                                                                              |
| `/shared/[token]` | Public share               | Unchanged and outside the authenticated shell; not visited.                                                                                      |

No new route or competing organization-wide inbox was added. Browser Back from
a review retains the preceding URL filters; the global Reviews link deliberately
returns to the all-reviews home. No cross-route selection/draft persistence was
introduced. Existing review bookmarks remain usable.

AppShell has a compact sticky header, quiet organization/account context, native
logout, a full-height structural side rail and a flexible near-full-width main.
The rail is 176px at >=1280 and 144px from 768 through 1279. Below 768, it becomes
an in-flow navigation disclosure rather than horizontal global scrolling or a
modal. Opening focuses its first link; Escape closes it and returns toggle focus.
Route navigation closes the disclosure. Named landmarks, aria-current and a
keyboard-visible skip link remain explicit. No Settings or subsystem destinations
were fabricated. History visibility mirrors existing audit roles, not a new
authorization policy; the old History page is not redesigned or re-certified.

## Truthful Inbox Contracts

| Presentation                                      | Authority / boundary                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Title, PR number, state/draft, author             | Direct list response; no assignment inference.                                                                                                               |
| Repository identity and scope link                | Required `repository.id/fullName` from the certified list response.                                                                                          |
| Branches, files, additions/deletions, update time | Direct list fields; tertiary branches reduce on narrow screens.                                                                                              |
| Stored risk                                       | Cached PR score/level, not latest/current-run risk. Null is Unavailable, never zero. LOW is neutral, never safe.                                             |
| Analysis                                          | Latest listed run status, independently labeled. COMPLETED is informational, not passed/safe/approved. Missing run is Not analyzed. No head-freshness claim. |
| Human review                                      | Deliberately omitted; current-head counts are not a complete verdict/history.                                                                                |
| Comments                                          | Deliberately omitted; `unresolvedCommentCount` actually counts all comments.                                                                                 |

Gate, finding counts, pinned head, assignment, unread state, saved views, SLAs,
waiting-on-author and personal review queues are **DEFERRED PRODUCT CONTRACTS**.
No per-row detail calls fill those gaps. Model version/UUIDs/full SHAs do not
dominate rows. Titles wrap and React escapes repository text. Open review is a
primary named link; Analyze is a separate ghost command, never invoked by render
or selection. AnalyzeButton's default remains primary for existing consumers;
only the inbox opts into its subordinate presentation. Polling, queue requests
and completion invalidation are unchanged.

Repository, PR state and stored-risk filters are server queries, not browser
filtering of a page. Ordering uses the audited existing server `sortBy/sortOrder`:
recent/least-recent GitHub update time or highest cached risk with nulls last.
Ascending risk URLs normalize to descending so they cannot contradict the
Highest stored risk label. No composite priority or custom backend ordering was
added. Existing equal-key ordering has no unique tie-breaker; concurrent changes
can move rows between offset pages. This is not snapshot-consistent pagination.
The final ascending-risk normalization is covered by focused tests and the final
production build. Its last browser attempt reached the correct selected label
while loading; the completed ordered result was not observed before interruption.

Reviews request 25 rows with server totals/page metadata. Previous/Next retain
scope and order; changing filters starts at page 1. Repository options request
50 per page and expose explicit Load more when available, not a silent all-repo
fetch. A selected repository outside loaded options uses authoritative returned
row identity when available, otherwise Selected repository; it never exposes a
foreign name or raw ID. Repositories themselves use 25-row server pages.

## States And Responsive Behavior

Loading uses named busy regions and four restrained skeleton review rows.
Separate empty states cover no connected repositories, repositories without
reviews, filter-empty and out-of-range pages. Filter-empty offers Clear filters;
out-of-range offers first-page recovery retaining filters. Query errors preserve
the shell and expose persistent local Retry, without raw errors or pretending
network failure means denied permission. Repository-option failure remains
separate from review-list failure and does not silently erase available reviews.

Desktop rows are an unframed semantic list with identity, independent signals
and primary action regions. At 800px metadata wraps; at 390px rows recompose into
stacked identity, visible risk/analysis and separate actions. HIGH remains visible.
No desktop table is squeezed into mobile, and no metric strip or Card-per-PR
layout survives. The existing framed sync-job panel remains a genuine tool;
connect/sync behavior and authorization are preserved, not rebuilt.

## Isolated Browser Evidence

Project: `codelens_phase4c_ui_20261006`. Dedicated containers:
`codelens_phase4c_ui_20261006-postgres-1` and
`codelens_phase4c_ui_20261006-redis-1`, dedicated default network, PostgreSQL
tmpfs and nonpersistent Redis. No existing volume was mounted or reused.
Ports: PostgreSQL loopback 56420, Redis loopback 56390, host API 55420,
production UI loopback 53420. The host API uses the existing all-interface
listener; this is a disposable local demo, not a deployment/security claim.
API CORS and compiled browser API URL both use the isolated UI/API origins.
Current unchanged API source was rebuilt, not the old 3G container image.

All eleven unchanged migrations deployed from empty. The user separately
approved normal demo initialization in this new database, including three seeded
RAG rows. No existing proof database was copied or changed. The host API runs
from an isolated working directory that does not load the real root environment;
its allowlisted environment uses fresh ephemeral signing/encryption keys, empty
GitHub/provider credentials and `RUN_WORKERS_IN_API=false`. No worker, provider,
broker or real ML operation was started. Optional ML/provider unavailability
remains visible in the existing health banner, not suppressed for screenshots.

Browser actions after seed were read/navigation plus disclosed authentication
session/audit side effects. No sync, Analyze, comment, conversation, proposal,
candidate, validation, reassessment, AI re-review, verdict, share, indexing or
GitHub operation was invoked. Domain readback remains one repository, two PRs,
one seeded ReviewRun, three RagChunks, zero seeded embeddings and two comments.
This seeded review is not live analysis evidence.

| Proof                                                 | Result                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid/valid manual sign-in; separate GitHub control | Truthful invalid-login feedback, valid Reviews landing; GitHub action independently available but not invoked.                                                                                                                     |
| Reload, logout, protected route                       | Refresh-cookie recovery works; logout and subsequent dashboard access return to signin.                                                                                                                                            |
| Repository filter, HIGH/CRITICAL filter               | Visible authoritative scope; HIGH returns #412; CRITICAL gives real filter-empty, clear restores list.                                                                                                                             |
| Server ordering                                       | Highest stored risk places #412 before unavailable-risk #415; no browser sort.                                                                                                                                                     |
| Repository -> View reviews -> Open review             | Scoped inbox and unchanged persisted #412 workspace reachable; Back retains scope.                                                                                                                                                 |
| Legacy URL                                            | Repository/HIGH bookmark redirects to the same canonical inbox.                                                                                                                                                                    |
| Pagination                                            | Two-row seed exposes correctly disabled first/last controls. Multi-page totals/URL preservation covered by focused tests; prerequisite previously proved real database pagination. No multi-page browser fixture was manufactured. |
| Error                                                 | Brief outage of only the new API exposed persistent list error/Retry while keeping shell. No product data was changed to force error.                                                                                              |
| Keyboard                                              | Skip link becomes visible and enters main; native filter Tab order, separate Open/Analyze, Enter repository navigation, mobile Enter/Escape and toggle focus return observed.                                                      |

The Windows Prisma client was initially DLL-locked by the newly running API.
Only that owned API process was stopped; regeneration then passed. Restarting
the proof launcher generated new ephemeral keys, so the old proof session was
invalidated and login was repeated. This is local verification configuration,
not an application authentication regression. Temporary API/UI outage messages
and expected signin 401 behavior were not suppressed. Browser diagnostic export
at the final signin document returned no retained entries; this is not proof that
earlier navigation emitted no diagnostics.

Seven final screenshots are outside the repository in the visualization workspace:
`phase4c-reviews-{1440,1280,1100,800,390}.png`,
`phase4c-repositories-1440.png`, `phase4c-mobile-navigation-390.png`.
All five inbox screenshots were inspected: zero positive horizontal overflow,
full title wrapping, visible HIGH risk and Open review, restrained rail and no
badge/card proliferation. Repository desktop and mobile navigation screenshots
were inspected. Mobile repository navigation also had zero overflow. The
unfocused sr-only skip link is intentionally clipped; when keyboard-focused it
was visibly within the viewport. Focus outline was browser-reported 1.6px at the
existing scale, not a new controlled 100%/200% zoom proof.

No WCAG certification, exhaustive screen-reader/clipboard/browser coverage,
large-organization pagination/load test or full Phase 3 mutation walkthrough is
claimed. Existing workspace stacking, clipping observations and the unrelated
91/CRITICAL versus 78/HIGH walkthrough drift remain unchanged. Phase 3C remains
deterministic PASSED, real investigation/tool/evidence PARTIALLY VERIFIED, real
final response/citations and multi-turn NOT VERIFIED.

## Verification And Integrity

Commands run with existing installed dependencies:

```powershell
node packages/database/node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json --test apps/web/test/design-system.test.tsx apps/web/test/review-inbox.test.tsx
pnpm test
pnpm -r --workspace-concurrency=1 --if-present typecheck
pnpm build:packages
pnpm --filter @codelens/api build
$env:NEXT_PUBLIC_API_URL='http://localhost:55420/api/v1'
pnpm --filter @codelens/web build
# A dummy non-connecting URL for source validation/client generation:
$env:DATABASE_URL='postgresql://verification:verification@127.0.0.1:1/verification'
pnpm --filter @codelens/database exec prisma validate
pnpm --filter @codelens/database generate
git diff --check
```

Focused frontend: 28 new cases + 16 existing = 44 passed. Cases exercise actual
rendered rows/inbox/native controls, transport query propagation, scope, redirect,
omitted misleading state, error/loading/empty, paging and escaped text. Internal
Next router contexts are test-only render scaffolding, not production injection.
No new test runner or root CI wiring. Workspace tests passed, including API 460,
AI-agent 111, static 47, RAG 29, shared 45 and migration checks 22. Existing opt-in
API persistence and Docker/runtime cases remain skipped in ordinary unit-suite
configuration. Sequential typecheck and package/broker/executor/API/web production
builds passed. Web build retains the existing lint-skipping configuration; this is
not an ESLint pass. The full state-mutating browser walkthrough was not run.
The resumed-session typecheck initially could not resolve unchanged patch-core's
installed `diff` package: direct reads returned EPERM. The authorized rerun
outside that filesystem restriction passed sequentially without source changes
or dependency installation.

Tracked canonical-extension Prettier comparison, honoring prettierignore:
143 failures at HEAD -> 138 after; no new tracked failures. Five removed failures
are only rewritten 4C surfaces. New UI/test/doc files pass separately. The API
wrapper still has pre-existing debt; its baseline/current formatting discrepancy
blocks are identical. The repository-wide raw-glob EPERM limitation against
ignored runtime directories remains; tracked-file comparison is the disclosed
measurement, not a repository formatting pass. No Python/Ruff changes or cleanup.

Direct-color pattern inventory: owned shell/dashboard/PR/repositories/Analyze/
health surfaces 67 -> 0; whole TSX source 263 across 29 files -> 196 across 23.
These are textual matches, not a claim of fixing every design defect. No review
workspace color debt was touched. No new dependency, token system or framework.

All eleven migration SQL files and migration lock compare byte-for-byte to HEAD.
Zero migrations added. Baseline SHA-256:
`e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.
Backend, shared contracts, auth/session implementation and all Phase 3 domain
files are unchanged. Scoped common key/private-key/literal-secret pattern checks
found no matches in proposed files; not a universal secret-non-leakage claim.

## Adversarial Review And Handoff

Scoped fixes during verification: standalone JSX loader imports, property-order-
independent markup assertions, viewport-height side rail, page-versus-filter-empty
recovery, a single Escape handler and ascending-risk label/request consistency.
No test-only branch or synthetic persistence entered production. No fabricated
queue, verdict, comment, freshness, safety, assignment or permission meaning.
No auth/domain/backend expansion, automatic work or future-workspace primitive.
No hidden detail composition, browser-only global filtering/sorting, giant
snapshot assertions, source HTML interpretation or unrelated formatting churn.

Deferred: missing list contracts, head freshness, deterministic tie ordering,
large/paged repository browser proof, full accessibility/zoom, redesigned History
errors and Phase 4D's actual diff/file/context/decision workspace. Global Reviews
resets filters; browser Back retains them. UI defaults to all accessible PR states,
not a fabricated needs-my-review view. Runtime artifacts remain ignored and must
not enter a commit. The disposable preview used `http://localhost:53420`; after
the interruption it was unreachable, and the resumed session could not resolve
Docker from PATH. Current preview availability is not claimed. Earlier browser
evidence is retained; no original runtime resource was stopped or modified.

Proposed subject: `feat(web): introduce Reviews-first shell and repository-scoped inbox`.

## Proposed File Inventory

Exactly 14 files (seven modified, seven new):

1. `apps/web/src/app/(app)/dashboard/page.tsx`
2. `apps/web/src/app/(app)/layout.tsx`
3. `apps/web/src/app/(app)/pull-requests/page.tsx`
4. `apps/web/src/app/(app)/repositories/page.tsx`
5. `apps/web/src/components/analyze-button.tsx`
6. `apps/web/src/components/health-banner.tsx`
7. `apps/web/src/lib/api.ts`
8. `apps/web/src/components/app-shell.tsx`
9. `apps/web/src/components/list-pagination.tsx`
10. `apps/web/src/components/reviews/review-inbox.tsx`
11. `apps/web/src/components/reviews/review-list.tsx`
12. `apps/web/src/lib/review-inbox.ts`
13. `apps/web/test/review-inbox.test.tsx`
14. `docs/phase4c-application-shell-review-inbox.md`

Excluded: unchanged untracked Phase 4A audit, ignored `.compose.phase4c.local.yml`,
`.codelens-tmp/phase4c/runtime/launch.cjs`, `runtime/host/README.md`, generated
API/web logs/PID files, screenshots, `.next`, Prisma/TypeScript build outputs and
all pre-existing local isolation/environment artifacts. None are required as
permanent product infrastructure. No staging, commit or push.
