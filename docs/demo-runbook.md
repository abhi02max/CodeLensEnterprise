# Local Demo Runbook

Use local/demo data only. This is not a production deployment guide.

1. Install Docker Desktop, Node 22 and the packageManager-pinned pnpm version.
2. Copy `.env.example` to `.env`. Generate JWT, refresh and encryption secrets
   using the commands in README. Keep this file untracked. Optional provider
   credentials are not required for the demo.
3. Run `pnpm install --frozen-lockfile`, then `pnpm docker:up`.
4. Inspect `docker compose ps` and `docker compose logs db-init`.
   A fresh database reports `empty`, applies `0_baseline` and verifies RAG.
   Subsequent initialization reports `managed`, with no pending migrations.
5. Run `pnpm docker:demo:init` explicitly. Never reset a database to fix startup.
6. Open http://localhost:3000 and sign in as `owner@acme.dev` with the documented
   local demo password. These intentionally public accounts must not be deployed
   to an exposed production instance.
7. Open Repositories, payments-api, PR #412, then Review. Source metrics are
   four files, +26/-5 and 31 changed lines. The pre-populated review is a fixture,
   not evidence of worker execution.
8. Select Analyze. Watch queued/running/completed state and the new run identity.
   Live demo pattern findings anchor to lines 58, 59 and 69; ML bootstrap risk is
   91/CRITICAL. This is synthetic demonstration data, not model accuracy proof.
9. Inspect Static findings, ML risk, Repository context and Pipeline. Without a
   provider key AI is explicitly skipped; static evidence and gate remain usable.
   Demo context may be lexical-only. Real embeddings require an embedding provider;
   deterministic test embeddings establish plumbing, not semantic quality.
10. Add a comment, reply, resolve/reopen, and discuss a finding. Submit request
    changes and approve. Approval is recorded but does not override blocking
    policy; the author cannot approve their own PR.
11. Create a share link, open it anonymously, verify read-only content and revoke
    it. Protected links require the passphrase again after reload. Never publish
    the token or passphrase in logs or screenshots committed to Git.
12. Open Activity for the human-readable audit trail. Stop with
    `pnpm docker:down` (no `-v`). Volumes survive. `docker:demo:reset` is an explicit
    collaboration cleanup operation, not an ordinary restart.

## Debugging

Use `/api/v1/health/live` for process liveness and `/api/v1/health` for dependencies.
Postgres/Redis failures are required failures; ML/AI/queue backlog can degrade the
API. AI health states configuration only, not provider reachability. Worker process
state alone does not establish consumption. Inspect `/jobs/:id` with tenant auth,
worker logs and persisted ReviewRun/ToolRun IDs. Correlate `trace`, job and run IDs.

For browser regressions, set explicit `WEB_URL`, `API_URL`, `DEMO_PASSWORD` and
`EXPECT_AI_STATUS=SKIPPED` when appropriate, then run `pnpm test:browser`.
Tests mutate the chosen demo database; use an isolated Compose project with
unique container names, host ports, browser/CORS URLs and newly named volumes.
Do not point them at a valuable database. Do not analyse PR #415 before the walkthrough.
