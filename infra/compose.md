# Local Compose Runtime

The core stack is PostgreSQL 16 with pgvector, Redis, the ML service, API,
dedicated BullMQ worker, and Next.js web app. Docker Compose starts the whole
stack. The API exposes `/api/v1/health`; it returns 200 for a usable, possibly
degraded API and 503 when PostgreSQL or Redis is unavailable.

## First-time setup

1. Copy `.env.example` to `.env` at the repository root.
2. Generate three independent secrets for `JWT_SECRET`, `JWT_REFRESH_SECRET`,
   and `ENCRYPTION_KEY`. Use 48 random bytes in hex for each JWT secret and 32
   random bytes in hex for the encryption key. For example, run
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
3. Run `docker compose up --build -d`.
4. Run `docker compose run --rm -e NODE_ENV=development db-init pnpm --filter @codelens/database seed:container`
   to add the Acme demo. This is explicit because normal startup must not add
   demo users to a live database.
5. Open `http://localhost:3000`. The seeded demo users and password are printed
   by the seed command. Check `http://localhost:4000/api/v1/health` and
   `docker compose ps` for readiness.

`pnpm docker:up` and `pnpm docker:demo:init` run steps 3 and 4 respectively.
The database setup job runs `prisma db push --skip-generate` after PostgreSQL
becomes healthy. There is no checked-in Prisma migration history yet. The job
does not accept data loss, so a schema change requiring destructive work fails
and needs an explicit migration decision. The PostgreSQL image installs the
`vector` extension; the init SQL enables `vector`, `pg_trgm`, and `pgcrypto` on
an empty volume. Prisma also declares these extensions. The API creates the
RAG ANN index and lexical search column at startup.

## Normal operation

- Start: `docker compose up -d`
- Rebuild after source changes: `docker compose up --build -d`
- Inspect: `docker compose ps` and `docker compose logs -f`
- Reset demo collaboration state: `pnpm docker:demo:reset`
- Stop: `docker compose down`

The reset preserves the latest completed review run for each PR. It does not
delete the database volume or replace PR #412's patch-derived metrics and
finding anchors. Run `pnpm docker:demo:init` again to restore the original
seeded collaboration entries after a reset. Do not use `docker compose down -v`
unless you intentionally want to delete all local database and queue data.

The API and worker use internal service URLs. `NEXT_PUBLIC_API_URL` is baked
into the web build and must be reachable from the browser. If you change the
host API port, set both `API_PORT` and `NEXT_PUBLIC_API_URL` before rebuilding.
GitHub OAuth also needs externally reachable callback and app URLs.

With no GitHub credentials, local accounts and seeded data still work. With no
AI provider key, AI review is skipped. Without a usable embedding provider,
repository indexing cannot generate vectors; seeded RAG context is still
available. The bundled ML model works without an external key. The container
does not install optional Semgrep or ESLint analyzers; the built-in pattern and
secret scans run. Local embeddings require a custom ML image with
`sentence-transformers` installed, since the default image omits it.
