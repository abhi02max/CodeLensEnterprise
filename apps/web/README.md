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

## Verification

```bash
pwsh -File apps/web/test/verify-web-flow.ps1     # 84 assertions
```

Exercises the browser's own auth mechanism with a cookie jar, then every endpoint each screen
calls, with field-level assertions matching what the components read. It also asserts both AI
states and adapts to whichever is configured:

- no provider key → `aiReviewStatus.state === 'SKIPPED'`, non-retryable, findings / risk / context
  / gate all still present
- key configured (real or the stub in `apps/api/test/fixtures/llm-stub.js`) → `'GENERATED'`, with
  the narrative present in both the workspace and the shared view, and provider, model, token usage
  and cost absent from the shared view

**Not covered:** browser interaction. The build, every route's response, and every API contract the
screens depend on are verified; clicking through the flow in a browser is not something these
assertions can do.

## Deliberately absent

No settings, billing, onboarding, charts or landing page. The MVP is one flow, and each of those
would be a second one.
