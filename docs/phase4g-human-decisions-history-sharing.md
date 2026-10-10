# Phase 4G: Human Decisions, History and Sharing

## Freeze Result

**READY_TO_FREEZE**, subject to separate human commit approval.

Starting and final HEAD: `ed63b3500f20b2f3d876db51192cabf1ffafbd13`.
No commit or push was performed. Phase 4H and 4I were not started.

This changeset is **not strictly frontend-only**: it retains the separately
authorized five-file share-route prerequisite, including an API URL helper and
its tests. No other backend, shared contract, schema, dependency, CI, provider,
execution policy, static rule, ML or RAG implementation changed.

## Exact Proposed Inventory

| Status | File                                                        | Ownership                                                |
| ------ | ----------------------------------------------------------- | -------------------------------------------------------- |
| M      | `apps/api/src/review-sessions/share-links.service.ts`       | Prerequisite URL correction only                         |
| A      | `apps/api/src/review-sessions/share-links.service.test.ts`  | Prerequisite regressions                                 |
| A      | `apps/web/src/app/shared/review/[token]/page.tsx`           | Historical URL compatibility                             |
| A      | `apps/web/test/share-route.test.tsx`                        | Compatibility and reader boundaries                      |
| M      | `apps/web/test/verify-web-flow.ps1`                         | Correct canonical URL assertion                          |
| M      | `apps/web/src/app/(app)/reviews/[id]/page.tsx`              | Decision integration; persistent reviewed-head pin       |
| M      | `apps/web/src/components/workspace/share-panel.tsx`         | Deliberate sharing and metadata readback                 |
| M      | `apps/web/src/lib/types.ts`                                 | Optional existing review PR association/update timestamp |
| A      | `apps/web/src/components/workspace/decision-workspace.tsx`  | Human verdict, evidence and history                      |
| A      | `apps/web/src/components/workspace/decision-workspace.css`  | Token-based responsive layout                            |
| A      | `apps/web/src/components/workspace/review-confirmation.tsx` | Native modal confirmation                                |
| A      | `apps/web/src/lib/review-decision.ts`                       | Identity, eligibility, safe errors and fencing           |
| A      | `apps/web/test/review-decision.test.tsx`                    | 38 deterministic frontend tests                          |
| A      | `docs/phase4g-human-decisions-history-sharing.md`           | This report                                              |

**14 files: five modified and nine added.** The prerequisite API test is actually
a new file, despite the resume inventory describing it as modified. The unrelated
untracked Phase 4A audit remains unchanged and excluded. Nothing is staged.

Ignored proof drivers/config/results are confined to `.codelens-tmp/phase4g-ui/`:
`runtime.cjs`, `compose.yml`, `db-proof.cjs`, `safety.cjs`, `browser.cjs`,
`component.tsx`, `components.cjs`, `integrity.cjs`, and their generated JSON records.
They are not production imports or proposed commit files. Screenshots are outside
the repository. No local environment file was used; runtime keys were ephemeral.

## Authoritative Contract Audit

Sources inspected: review-session controller/service/share service and tests,
shared DTOs, PR detail/diff contracts, authorization guards, organization audit
controller, frontend API/client/providers, existing shared reader/configuration,
and Phase 3/4 documentation. The following classifications concern the actual
existing contract, not hypothetical backend capabilities.

| #   | Capability                 | Classification and boundary                                                                |
| --- | -------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | PR detail/revision         | SUPPORTED: persisted PR ID, repository and head; separate diff provenance                  |
| 2   | Authoritative current head | SUPPORTED locally; live remote freshness UNSUPPORTED by page read                          |
| 3   | Verdict types              | SUPPORTED readback: APPROVED, CHANGES_REQUESTED, NEEDS_DISCUSSION                          |
| 4   | Eligibility                | SUPPORTED: current membership, role, author restrictions and merged state                  |
| 5   | Creation                   | SUPPORTED: approve/request-changes only; discussion creation UNSUPPORTED                   |
| 6   | Readback                   | SUPPORTED: authenticated tenant-scoped session                                             |
| 7   | History                    | SUPPORTED verdict rows; complete immutable chronology UNSUPPORTED                          |
| 8   | Authorization              | SUPPORTED: server REVIEWER guard and service permission checks                             |
| 9   | Head binding               | SUPPORTED: expectedHeadSha compared under server transaction                               |
| 10  | Concurrency/stale          | SUPPORTED server 409; client mismatches SAFELY DERIVABLE                                   |
| 11  | Idempotency                | SUPPORTED same reviewer/head row upsert; universal exactly-once UNSUPPORTED                |
| 12  | Audit                      | SUPPORTED safe persisted events; separate organization audit access                        |
| 13  | Timestamps                 | SUPPORTED createdAt/updatedAt; overwritten prior value not recoverable                     |
| 14  | Actor                      | SUPPORTED reviewer identity; missing legacy identity labeled unavailable                   |
| 15  | Proposal vs PR             | SUPPORTED distinct domains; acceptance is future application approval only                 |
| 16  | Share endpoints            | SUPPORTED create/list/revoke and existing public token reader                              |
| 17  | Creation semantics         | SUPPORTED ADMIN operation, random token, stored hash, URL returned once                    |
| 18  | Visibility                 | SUPPORTED SUMMARY/FULL allowlisted projection                                              |
| 19  | Access                     | SUPPORTED bearer URL plus optional passphrase; recipient invitations UNSUPPORTED           |
| 20  | Expiration                 | SUPPORTED server enforcement; local-clock display SAFELY DERIVABLE and qualified           |
| 21  | Revocation                 | SUPPORTED recorded revokedAt and server denial; repeated revoke may conflict               |
| 22  | Share readback             | SUPPORTED permitted current recorded data, not an immutable snapshot                       |
| 23  | Tokens                     | SUPPORTED creation-time URL only; historical recovery UNSUPPORTED                          |
| 24  | Sensitive projection       | SUPPORTED existing allowlist/static-snippet redaction; universal redaction UNSUPPORTED     |
| 25  | Scope                      | SUPPORTED tenant/repository/PR server ownership and scoped failures                        |
| 26  | Frontend methods           | SUPPORTED existing typed verdict/share/session methods; no new endpoint                    |
| 27  | Errors/loading             | SUPPORTED HTTP categories; named empty/pending/conflict/unavailable UI                     |
| 28  | Cache/polling              | SUPPORTED existing query cache; no new polling or background action                        |
| 29  | Pagination                 | Verdict/share list server pagination UNSUPPORTED; progressive display of all returned rows |
| 30  | Historical limits          | Overwrite/incomplete-source limits disclosed; no reconstructed events                      |

## Product Experience and Decision Safety

Changes remains the default. Investigation, Candidates, Discussion and Analysis
remain available. The existing Decision view now contains compact Review,
History and Sharing sections, rather than stacked duplicate verdict controls.
Existing proposal/candidate controls are not redesigned or invoked.

The decision shows repository/PR identity, full known persisted head, reviewed
target, own recorded verdict where available, eligibility, recorded analysis and
policy gate. Only supported approve/request-changes choices are offered.
NEEDS_DISCUSSION remains readable in history, never a creation option.

The page preserves the first reviewed-head pin across leaving/re-entering
Decision. Within Decision, switching sections retains the draft. Session/PR/repo
identity, valid exact SHA and matching detail/session/reviewed heads must agree.
Failed detail reads cannot authorize a decision from cached detail. A changed
head clears confirmation/rationale and requires explicit acknowledgement. It is
not silently repinned by navigation or a successful refresh.

The server remains authoritative. Submission carries expectedHeadSha and occurs
only after a native confirmation dialog. Synchronous fencing rejects a second
activation before React renders pending state; pending controls are disabled.
There is no automatic retry or optimistic success. Returned head, reviewer, PR
association when provided, and verdict must match before success is displayed.
409 and other unconfirmed outcomes block resubmission until a successful scoped
GET and explicit renewed review. Raw server exception messages are not used in
these action diagnostics. Network ambiguity is not described as definite failure
or exactly-once execution.

CodeLens verdicts are local review records, not GitHub reviews, merges,
deployments, code changes or security guarantees. A gate satisfied in the read
does not perform a merge. Proposal acceptance and candidate validation do not
approve the original PR.

## Evidence and History Semantics

The decision evidence summary requires completed, nonstale analysis with an exact
matching persisted head. It separates deterministic findings/severity, advisory
ML, recorded AI and indexed retrieval. Missing/partial/historical analysis is not
presented as clean; missing ML is unavailable rather than zero. Indexed context
is not exact source applicability. Investigation/conversation/candidate evidence
stays in its scoped views; this compact summary does not invent a selected
candidate or claim completeness.

History preserves server creation-order readback, recorded full revision, actor,
creation/update timestamps where returned, rationale and stale/current-head
qualification. Explicit foreign PR associations are withheld. Legacy rows without
that optional field rely on the existing tenant-scoped session contract; the
frontend does not independently establish tenant authorization. Empty results
mean no rows returned, not proof that no historical decisions ever existed.

Same-reviewer, same-head updates replace a verdict row. The UI is labeled
"Review decision history", not a complete immutable audit trail. It neither
fabricates supersession nor merges unrelated event types into a chronology.
All returned records can be progressively displayed; counts and lack of server
pagination are explicit. ADMIN/OWNER can navigate to separate organization
history. No organization audit request is added to Decision by default.

## Sharing and Route Prerequisite

Canonical URL generation now uses the configured public base plus
`/shared/<token>`. The historical `/shared/review/<token>` frontend route performs
a same-origin 307 redirect to that reader, encodes its opaque parameter, and
forwards no query parameters. It adds no reader/API/access logic. Token entropy,
hashing, passphrase checks, expiry, revocation, scope, redaction and reader
authorization remain unchanged. The existing PowerShell walkthrough assertion
now checks the canonical shape; the mutation-heavy walkthrough was not executed.

Create and revoke use their independent server-provided permissions and explicit
confirmation. SUMMARY and static-snippet redaction are conservative UI defaults,
not new backend restrictions. FULL narrative sensitivity and the limits of
snippet redaction are disclosed. Only supported expiration intervals are offered;
passphrase input follows existing optional 8-200 character bounds.

Issued URLs are held only in the mounted component, never local/session storage
or credential-bearing mutation results/variables. The raw token is not retained
separately. Copy uses that issued URL, not the currently edited scope, with
generation fencing for late clipboard settlement and truthful denial feedback.
No passphrase is appended. Open uses the issued server URL with noreferrer and
noopener. No real link was created/opened or recorded share view invoked during
browser proof (the existing shared read increments view/audit state).

History renders metadata, never its URL field or recovered tokens/passphrases.
Revocation uses recorded revokedAt; expiry-derived text explicitly says local
clock and is not a server access guarantee. Shared payloads remain the existing
allowlist; private collaboration/candidate records are not reconstructed through
authenticated endpoints. Bearer recipients are not enumerated or invited.

## Verification Results

| Check                                                   | Actual result                                              |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| New Phase 4G frontend deterministic tests               | 38 passed                                                  |
| Share-route frontend prerequisite                       | 4 passed                                                   |
| All standalone frontend tests                           | 255 passed, zero skips                                     |
| Focused API sharing/verdict/gate/labels/exception tests | 40 passed in five files                                    |
| Full workspace tests                                    | 907 passed, 21 existing skips                              |
| Sequential workspace typecheck                          | PASSED after final corrections                             |
| Package/broker/executor/API production builds           | PASSED in owned API Docker build                           |
| Final production Next build                             | PASSED; build ID `FTuq71-hXuQ4aZEMm3fNg`                   |
| Prisma validate/generate                                | PASSED with unused explicit loopback URL, no DB connection |
| Scoped formatted/new UI/test files                      | PASSED                                                     |
| Tracked Prettier comparison                             | 136 baseline -> 135; no new failures                       |
| git diff --check                                        | PASSED                                                     |
| Production browser                                      | 69 assertions passed                                       |
| Isolated component mocked-handler proof                 | 13 assertions passed                                       |

Workspace totals were summed from actual package reports: shared 45, executor
28, AI-agent 111, database 23, GitHub 88, static 47, validation broker 10, patch
core 23, RAG 29, patch executor 10, sandbox broker 12, API 481. The 21 skips are
the existing platform/opt-in runtime checks, not hidden failures. Standalone
frontend tests are a separate command; no hosted CI pass for this uncommitted
changeset is claimed.

The current unchanged CI workflow runs workspace tests, not the separate
standalone frontend command. The 255 frontend tests therefore remain an explicit
local verification step; no CI integration was added under this scope.

The one resolved formatting failure is the share panel necessarily rewritten in
this phase, not a mass-formatting pass. Existing API share-service and web types
formatting debt remains: only the URL expression and two optional type fields
were edited, respectively. Their unrelated formatting was preserved. PowerShell
syntax validation passed. No Python/Ruff files changed; Ruff debt is not cleaned
or newly certified.

Deterministic tests cover scope/head eligibility, stale and legacy records,
permissions, provenance, incomplete history, source escaping, share bounds and
metadata, error redaction, fencing and confirmation. Consequential interactions
use an isolated component harness with mocked function handlers, not successful
HTTP POST simulation: pending/double activation, no optimistic success, 409
refresh/acknowledgement, matching success readback, current FULL/SUMMARY/FULL
URL copying, passphrase omission, mutation-cache safety and clipboard denial.
These are component proofs, not real verdict/share persistence evidence.

## Production Browser Proof and Cleanup

New project: `codelens_phase4g_ui_20261008`.
Owned containers: project-prefixed `postgres-1`, `redis-1`, `api-1`.
Database/user: `codelens_4g_ui`; PostgreSQL data was tmpfs. Redis persistence was
disabled/tmpfs; no named volumes were reused or created. Owned networks:
`codelens_phase4g_ui_20261008_default` (internal) and
`codelens_phase4g_ui_20261008_loopback` (bridge for published loopback access).
Ports: PostgreSQL 56471, Redis 56397, API 55472, production Next 53472.
New API image tag: `codelens-phase4g-ui-20261008:api`.

Before the explicit seed, the fresh database had zero organizations, reviews and
shares, with all 12 migrations applied. Normal deterministic seed then created
the unchanged #412 fixture, 78/HIGH risk and three demo RAG rows. Workers were
disabled, external credentials empty and no ML/provider service was invoked.

REAL proof used normal OWNER and DEVELOPER demo authentication, cookie session
refresh and seeded reads. It checked Changes UNVERIFIED provenance, reachable
investigation, empty candidates, persisted head/78-HIGH evidence, recorded seed
verdict, empty share metadata, return navigation and real role-dependent controls.

SYNTHETIC GET-only fixtures checked historical verdicts (including discussion),
share metadata, head movement, foreign detail mismatch and unavailable reads.
They never mocked auth, wrote product rows, exercised providers/execution or
simulated successful product POSTs. The new-head regression included switching
sections and leaving/re-entering Decision before explicit acknowledgement.

At each of 1440, 1280, 1100, 800 and 390 widths, confirmation, history, sharing,
progressive records, keyboard focus, Escape restoration, draft continuity and
page containment passed. Page scroll width matched each viewport. Confirmation
widths were 560px desktop/intermediate and 358px at 390. Screenshots were inspected
locally and remain outside Git at the visualization workspace's `phase4g` folder.
The native modal uses focus containment, safe cancel focus, Escape and restoration;
labels/statuses do not depend on color. This is not WCAG/screen-reader/all-browser
certification. Broader prior clipping observations remain disclosed.

Final run network record: 37 REAL GET, 10 SYNTHETIC GET and 12 REAL auth POST:
nine refresh, two signin, one signout. Zero forbidden product mutation attempts,
zero external-origin attempts, zero runtime exceptions. Expected prelogin/logout
401 messages and three synthetic 503 diagnostics were retained, not suppressed.
Network records contain method/path/source only, no headers or response tokens.

After all attempts, count/content fingerprints of 49 domain tables were unchanged
from the post-seed baseline. User/account/auth audit changes were excluded because
session activity was authorized. Conversations, proposals, applications and
validations remained empty. API logs contained zero matches for the three actual
ephemeral key values; provider/GitHub keys were empty. This is scoped evidence,
not universal non-leakage or infrastructure-log certification.

Cleanup removed all three owned containers, both networks, tmpfs databases/cache
and owned image tag. Production Next and temporary component HTTP/browser
processes terminated. All four fixed loopback ports had no listeners afterward;
the component server closed its dynamically allocated port. Pre-existing
container/volume identities remained present. Generic Docker build cache was not
pruned. Ignored proof records remain local, excluded from the proposed commit.

## Integrity and Adversarial Review

All 12 migration files and lock are byte-identical to starting HEAD.

- `0_baseline`: `e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`
- Diff provenance: `883415a0f00d3001f9fa5e71f832a38aba7916b7d2e55a07a143c4be00cdf698`
- Migration lock: `da12fa8151832c7297598b1504d698d41d7b1f6331b5bb7f458e8725356ba9c8`
- Untracked 4A audit: `a64f828808d5eb3dd5fb72e3179432f6af7b2c03e414b9bca0e877343c98d08c`

Scoped adversarial corrections before final verification: preserve reviewed pins
through section/top-level remounts; require successful scoped reads and explicit
review after unconfirmed decisions; validate returned verdict/actor/head; reject
legacy empty revisions as current; withhold mismatched detail/history; keep issued
URL/passphrase out of mutation results/variables; fence late clipboard feedback.

Final review found no outstanding Phase 4G blocker: no automatic verdict/share,
GitHub write, provider request, source HTML interpretation, synthetic production
fixture, new execution privilege, chronology fabrication or expanded shared
payload. Existing server guards/reader projection remain authoritative. New UI
introduces no polling; existing session eagerly returns unpaginated history,
which the UI cannot turn into server pagination. Broader legacy fetching/polling
and list-scale limits are not claimed fixed. Local design primitives/tokens were
reused; 21st catalog search required sign-in, so no external review/source upload
or 21st review pass is claimed.

Final whitelist verification found exactly the 14 proposed files and no staged
files. A scoped private-key/GitHub/OpenAI/Google credential-pattern scan returned
zero matches in those files; production-source checks found no proof fixture
identities or local driver imports. These checks do not prove universal secret
non-leakage. The ignored proof configuration/results and untracked 4A audit remain
outside the proposed inventory.

## Remaining Limitations and Roadmap

- No new real verdict/share creation, revocation, bearer read or persistence was
  performed. Browser role controls do not certify backend authorization; focused
  API regressions and prior Phase 3 evidence retain their actual scope.
- Persisted head is not live GitHub freshness. Server races remain authoritative;
  UI fencing does not establish universal exactly-once processing.
- Verdict overwrite history, historical raw URL recovery, share recipients,
  immutable share snapshots and paginated verdict/share APIs are unsupported.
- Current summary is deliberately not exhaustive; candidate/investigation
  evidence stays independently scoped and is not treated as an original-PR fix.
- Known 91/CRITICAL walkthrough versus unchanged 78/HIGH seed drift remains
  untouched. The full mutation-heavy walkthrough was not rerun.
- Existing formatting/Ruff debt, expected auth diagnostics, prior broader clipping
  and legacy UI/polling limits remain disclosed. No hosted CI for this diff yet.
- Phase 3C deterministic verification PASSED; real Gemini investigation/tool/
  evidence PARTIALLY VERIFIED; real final grounded response/citations NOT VERIFIED;
  real multi-turn collaboration NOT VERIFIED. Real-provider AI re-review remains
  NOT VERIFIED. This phase made no provider call and upgrades none of those claims.
- Phase 4H remains broad accessibility, responsiveness, performance, functional
  UI regression and usability. Phase 4I remains logo/branding/type/color/texture/
  icons/layout/motion/visual consistency; neither was implemented.
- Phase 5 retains organizations/permissions, GitHub lifecycle, security/secrets,
  XSS/SQL injection/CSRF/CORS/rate limits/database protection/dependency scanning,
  AI-specific threats, privacy/legal requirements and public website.
- Phase 6 retains production infrastructure/observability/backups/recovery,
  reliability/load/security validation and controlled launch. No production
  readiness or comprehensive security certification is inferred from this UI proof.

Proposed subject: `feat(web): integrate human review decisions history and sharing`.
**STOP before commit or push.**
