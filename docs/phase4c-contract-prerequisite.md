# Phase 4C Contract Prerequisite

## Scope And Root Cause

Starting and final HEAD: `6b843bfe4c37c18645e9512a19ce849a9d4495cc`.
This is the uncommitted read-only listing prerequisite, not the Phase 4C UI.

`ListPullRequestsQuerySchema` omitted `repositoryId`. The controller's Zod
validation pipe returns the parsed value, stripping that unknown key before
the existing service filter could receive it. Direct source-schema execution
confirmed `repositoryIdPreserved: false` before the correction. The list also
lacked repository identity, preventing a reliable browser join without one
PR-detail request per row.

## Exact Correction

- Add `repositoryId: IdSchema.optional()` to the existing shared query schema.
  The existing identifier convention is a string of length 1 through 64; it is
  not a newly enforced CUID-format validator. Omission retains existing defaults.
- Remove the service's redundant ad hoc query-type intersection now that the
  authoritative parsed contract includes the optional filter.
- Include `repository: { select: { id: true, fullName: true } }` in the existing
  PR relational query and explicitly project those two fields into each result.
- Add the required repository shape to shared and browser list response types.
  Existing detail responses retain their additional `defaultBranch` field.

The response addition is exactly:

```typescript
repository: {
  id: string;
  fullName: string;
}
```

No controller implementation change, browser API-wrapper change, compile-only UI
adaptation, schema migration, dependency or visual change was needed. Existing
response fields, query defaults, filters and sorting are otherwise unchanged.

## Security And Pagination

The controller still obtains organization scope from `@OrgId()`. A client-supplied
`organizationId` is not accepted by the query schema. The service applies both
the server-derived `organizationId` and optional `repositoryId` in the database
`where`, before `skip`/`take`. The count query uses the same filter. An absent
repository filter leaves the organization-wide query unchanged.

There is no foreign-repository existence lookup or new error. A foreign ID and
a nonexistent ID return the same empty paginated response, without foreign
repository identity. Existing authentication/membership guards remain unchanged.

Real persistence proof used only the newly created disposable container
`codelens_phase4c_contract_20261006_postgres`, bound to loopback port 56420 with
database `codelens_pr_list_contract_test`. PostgreSQL storage was memory-backed;
no existing CodeLens volume was mounted or reused. The unchanged eleven checked-in
migrations deployed successfully into this initially empty database. Two synthetic
tenants, three repositories and five PRs were created solely as test fixtures.
This is not demo seeding or external repository mutation.

The actual validation pipe, controller and service were exercised with a real
Prisma client. This is real database proof, not a hosted HTTP/JWT/browser test.
Existing authentication was source-reviewed, not re-certified by these tests.

Evidence:

- Tenant A repository one returns PR numbers `[3, 2]` then `[1]` at page size 2,
  with filtered total 3, two pages and correct next/previous flags.
- Tenant A organization-wide pages return `[4, 3]` then `[2, 1]`, total 4.
- Tenant A requesting tenant B's repository, including a forged query organization,
  returns exactly the same response as a nonexistent repository: empty items,
  zero total, one empty page. No tenant-B repository name or ID appears.
- Tenant B can read its own repository, proving the foreign fixture exists.
- Each list repository object has exactly `id` and `fullName`. Detail readback
  retains `defaultBranch`. Null risk and missing runs remain null.
- Existing search/state/order combine with repository scope correctly.

## N+1 Avoidance

The service adds a relation include, not a loop or individual repository lookup.
Prisma query-event observation compared one returned row with four returned rows:
the total query count stayed constant and there was exactly one batched repository
read in each case. This does not claim the entire relational listing is one SQL
statement; existing reviews/runs/files/comment-count loading remains unchanged.
Query text/parameters were not printed or persisted as diagnostics.

## Verification

Focused verification passed: shared schema 9 tests; validation/controller/service
3 tests; real PostgreSQL persistence 6 tests (18 total). The ordinary workspace
suite passed, including shared 45, API 460, AI-agent 111 and database migration
checks 22. The six new persistence cases are opt-in and skipped in ordinary
workspace execution; they were run separately against the dedicated database.
Three existing validation-broker Docker cases remain skipped in the unit-suite
configuration. No real provider, OAuth or GitHub test was invoked.

Commands used:

```powershell
pnpm --filter @codelens/shared test -- src/contracts/repository.test.ts
# Set PR_LIST_TEST_DATABASE_URL only to the dedicated isolated database.
pnpm --filter @codelens/api exec vitest run src/pull-requests/pull-requests.service.test.ts src/pull-requests/pull-requests.persistence.test.ts
pnpm build:packages
pnpm test
pnpm -r --workspace-concurrency=1 --if-present typecheck
pnpm --filter @codelens/api build
pnpm --filter @codelens/web build
# Prisma validation uses a dummy non-connecting DATABASE_URL.
pnpm --filter @codelens/database exec prisma validate
pnpm --filter @codelens/database generate
git diff --check
```

Sequential workspace typecheck, package/broker/executor production builds, API and
web production builds, Prisma validation/generation and whitespace checks passed.
The new schema/controller tests initially assumed page size 50; the existing
server default is 25. Only those test expectations were corrected, without changing
the server default or the browser wrapper's explicit 50.

New test/doc files pass scoped Prettier. The three touched production files already
failed Prettier at HEAD; baseline/current formatting discrepancy blocks are
identical, with no new formatting debt. Existing import, verdict-count and shared
review-type formatting was deliberately not cleaned up. No mass formatting,
Python/Ruff change or repair of the known 91/CRITICAL versus 78/HIGH drift occurred.

## Integrity And Adversarial Review

Zero migrations added or modified. All eleven SQL migrations and migration lock
remain byte-identical to HEAD. Baseline SHA-256 remains
`e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.
The untracked Phase 4A audit is unchanged and excluded from this inventory; the
Phase 4B document is unchanged. No ignored proof driver, local Compose/env file,
credential, screenshot or generated runtime report is proposed for commit.

Adversarial review confirms database-level tenant AND repository scope, matched
count filters, additive projection, bounded identifier validation, no repository
existence disclosure and no per-row lookup. Existing risk, verdict/comment counts
and run meanings are unchanged. Scoped credential-pattern checks found no supplied
key/private-key patterns or literal secret assignments in proposed files; this is not a
universal secret-non-leakage claim. Real integration tests opt in through a dedicated
URL, reject nonlocal/different database names, require empty test persistence and
delete only their own random-ID tenant fixtures. They never fall back to the normal
DATABASE_URL; they are excluded from compiled production API output by its existing
test-file exclusion.

No existing Docker project/data was altered. No provider calls, GitHub product
mutations, fixture PR mutation, repository sync, RAG indexing, analysis execution
or review decisions occurred. Existing real-provider limitations remain unchanged.

## Deferred Findings And Handoff

- Human-review counts exclude verdicts on older heads; no assignment is inferred.
- Stored PR risk is not guaranteed to represent the latest analysis run.
- `unresolvedCommentCount` still counts all comments; it is not repaired or
  reinterpreted by this prerequisite and must not be labeled unresolved in 4C.
- Gate, finding counts and pinned head are absent from list responses.
- Assignment, unread state and saved views remain unsupported product contracts.

Prerequisite exit criteria A-N are satisfied within the disclosed verification
scope. Recommendation: **READY_TO_FREEZE_CONTRACT_PREREQUISITE**.
Proposed subject: `fix(api): preserve repository scope in pull request listings`.
No commit or push was made. Phase 4C UI and Phase 4D have not started. Resume 4C
only after separate approval; consume this additive identity/filter contract
without expanding any of the deferred fields or authority semantics.
