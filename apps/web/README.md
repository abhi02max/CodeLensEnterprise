# @codelens/web

Next.js review workspace for CodeLens Enterprise. One demo flow, built against the real API:
**sign in → repository → pull request → analyze → review → comment / verdict / share.**

## Running it

The API must be up first (see [apps/api/README.md](../api/README.md)).

```bash
pnpm --filter @codelens/web dev     # http://localhost:3000
pnpm --filter @codelens/web build
```

`NEXT_PUBLIC_API_URL` defaults to `http://localhost:4000/api/v1`. Copy `.env.local.example` to
`.env.local` to point elsewhere. The browser calls the API directly rather than through a Next
rewrite: the API already allows this origin with credentials, and keeping the real endpoints in the
network tab is worth more during a demo than hiding them behind a proxy.

## Screens

| Route | Purpose |
| --- | --- |
| `/signin` | Email + password against `POST /auth/signin` |
| `/dashboard` | Org name, counts, risk distribution, recent runs, degraded-service banner |
| `/repositories` | Connected repos, index state, queued GitHub sync |
| `/pull-requests` | PRs with risk and run state, filterable by repository, Analyze action |
| `/reviews/[id]` | The review workspace |
| `/shared/[token]` | Read-only shared review, no authentication |
| `/activity` | Audit events |

`/` resolves the session and redirects. There is no landing page — a marketing screen between an
engineer and the thing they opened the tab to do is friction, not positioning.

## Auth: the access token is never persisted

It lives in a module variable, not `localStorage`. A token in `localStorage` is readable by any
script that reaches the page, so one bad dependency becomes a stolen session that outlives the tab.

A reload therefore starts with no token, and `bootstrapSession()` exchanges the httpOnly refresh
cookie for a fresh one before any query runs. That works because `localhost:3000` and
`localhost:4000` are the **same site** — ports are not part of the site definition — so the
`SameSite=Lax` cookie is sent, and the API allows credentials from this origin.

Concurrent 401s collapse into a single in-flight refresh. Without that, six queries firing on mount
against an expired token would issue six refreshes and race each other.

## Design

Restrained on purpose. The neutral scale carries the layout and **colour is reserved for risk and
severity** — if buttons and headings were also coloured, a CRITICAL badge would compete with chrome
for attention. Colour is never the only signal either: every badge states its level in text.

Type scale is denser than Tailwind's default because a review screen has a lot to show and
scrolling past it is worse than reading it slightly smaller. Desktop is the priority; the layout
collapses to one column and stays usable on a phone.

UI primitives are hand-written in the shadcn/ui idiom (`src/components/ui/primitives.tsx`) rather
than installed. shadcn was not already configured and its CLI would pull in Radix packages this
flow does not need — there are no menus, popovers or comboboxes here.

## What the UI refuses to render

- **`ToolRun.output`** — the workspace payload omits it, and it holds raw analyzer and provider
  payloads.
- **Audit `metadata`** — the endpoint returns it; the activity panel renders only action, actor,
  description and time. A panel that prints whatever it is handed is how finding fingerprints and
  resource ids end up on a screen mid-demo.
- **Evidence ids** — AI findings show *how many* tool runs back them, not the cuids.
- **Anything on the shared route the API withholds.** That page is written against the share
  endpoint's allowlisted payload; it does not fetch the workspace and filter it down.

Error states show the API's `traceId` when there is one. It is the only handle connecting what the
user saw to the server log line.

## Resetting the demo data

```bash
pnpm db:reset-demo
```

Every demo and every verification pass adds threads, verdicts and share links to the same seeded
pull request, and forces another analysis run. It accumulates: after a dozen passes the Discussion
panel measured 2544px tall and the Share panel 1747px, which buried the AI review and the merge gate
under noise the product did not generate. The reset deletes comments, verdicts and share links,
prunes runs down to the newest **completed** one per pull request, and clears the verdict-derived
training labels. It leaves the organization, users, repository, pull requests and the surviving
analysis alone, so the workspace still has real findings and a risk score immediately afterwards.

Audit entries are not deleted. The audit trail is append-only by design, and a reset script that
edits it would be the wrong thing to own. The activity panels are bounded instead.

Re-seeding is not an alternative: `pnpm db:seed` upserts, so the accumulation survives it.

Two details worth knowing:

- Only a `COMPLETED` run counts as the keeper. PR #415 is seeded un-analysed on purpose so the
  "Not analysed yet" state is demonstrable, and one experimental `analyze` call against it left a
  run stuck at `FETCHING_DIFF` — which then became the state the list reported, permanently.
- The panels are also bounded independently of the reset, so a demo that runs long still reads
  cleanly: Discussion shows 6 threads, Share shows active links only, activity is capped.

## Verification

```bash
pwsh -File apps/web/test/verify-web-flow.ps1     # 84 assertions, API contracts
node apps/web/test/browser-walkthrough.mjs       # 80 assertions, real browser
```

The browser walkthrough drives **system Chrome** through Playwright (`channel: 'chrome'`) rather
than a bundled Chromium, because `playwright install chromium` could not complete on this network.
It signs in, walks the demo flow, creates a comment, submits both verdicts, creates and opens a
share link, and checks the tablet and mobile layouts. Alongside the functional assertions it audits
each page for document overflow, elements wider than their container and clipped text, and fails on
any unexpected console error. Screenshots land in `test/screenshots/` (gitignored) with a
`report.json`.

Run it against `next start`, not `next dev`. A `next build` while a dev server is live overwrites
`.next/` from under it, and every `_next` chunk starts 404ing — which looks exactly like a broken
app and is not.

Two assertions exist specifically because an earlier version of each passed while the screen was
wrong:

- Panels are located by `getByRole('heading')`, not by text. Audit descriptions legitimately contain
  phrases like "merge gate", and substring matching matched those instead.
- Mobile checks measure the **position** of the risk cell and the Review link. A table inside
  `overflow-x-auto` can be wider than its container with both parked off-screen while the document
  reports zero overflow.

Exercises the browser's own auth mechanism with a cookie jar, then every endpoint each screen
calls, with field-level assertions matching what the components read. It also asserts both AI
states and adapts to whichever is configured:

- no provider key → `aiReviewStatus.state === 'SKIPPED'`, non-retryable, findings / risk / context
  / gate all still present
- key configured (real or the stub in `apps/api/test/fixtures/llm-stub.js`) → `'GENERATED'`, with
  the narrative present in both the workspace and the shared view, and provider, model, token usage
  and cost absent from the shared view

**Not covered:** whether a real model writes a *good* review. The stub proves the path — parsing,
schema validation, the repair loop, the evidence filter, policy reconciliation, persistence — and
the browser pass proves the screens render it. Judging the prose needs a provider key and a person
reading the output. Also not covered: any browser other than Chrome, and screen-reader behaviour.

## Deliberately absent

No settings, billing, onboarding, charts or landing page. The MVP is one flow, and each of those
would be a second one.
