# CodeLens Enterprise

Enterprise AI + ML assisted code review and collaboration platform for GitHub pull requests.

CodeLens is deliberately **not** an LLM wrapper. A review is assembled from four independent
evidence sources before any language model is involved:

| Layer | What it contributes | Determinism |
| --- | --- | --- |
| **Static analysis** | ESLint, Semgrep, `npm audit`, `tsc` findings scoped to the diff | fully deterministic |
| **ML risk engine** | calibrated risk score, review-time estimate, similar historical PRs, SHAP-attributed reasons | reproducible per model version |
| **RAG repo context** | the architecture, conventions, API contracts and tests the PR actually touches | reproducible per index version |
| **GenAI agent** | prioritization, explanation, suggested fixes and tests — grounded in the three layers above | schema-validated |

The language model's job is to explain and rank evidence, not to invent it. Security and
critical findings that arrive without a backing tool run are dropped during validation.

---

## Architecture

```
apps/web  (Next.js)  ──▶  apps/api  (NestJS)  ──▶  Postgres + pgvector
                               │                   Redis + BullMQ
                               ├──▶  GitHub API
                               ├──▶  apps/ml-service  (FastAPI · sklearn · XGBoost)
                               └──▶  LLM provider     (OpenAI · Anthropic · OpenRouter)
```

The web app never talks to GitHub, the ML service, or an LLM directly. All orchestration,
RBAC, quota and audit enforcement lives in the API.

### Monorepo layout

```
apps/
  web/                 Next.js App Router frontend
  api/                 NestJS REST API + BullMQ workers
  ml-service/          Python FastAPI ML inference + training
packages/
  shared/              Zod contracts, DTO types, enums, constants
  database/            Prisma schema, client, migrations, seed
  github/              Octokit client, diff parser, rate limiting
  static-analysis/      ESLint / Semgrep / npm-audit runners + feature extraction
  rag-engine/          AST chunker, embedder, vector store, hybrid retriever
  ai-agent/            MCP-style tool registry, orchestrator, prompts, providers
infra/
  postgres/init.sql    pgvector + pg_trgm extensions
  semgrep/rules/       organization-specific rules
```

---

## Quick start

### Prerequisites

- Node.js 20+ and pnpm 9+
- Docker Desktop (Postgres + Redis)
- Python **3.11 or 3.12** (only if running the ML service outside Docker)

> Use 3.11 or 3.12 specifically. On 3.13+ there are no prebuilt wheels for
> scikit-learn, numpy and xgboost at these pinned versions, so pip falls back to
> compiling from source and fails without a full C/C++ toolchain. The Docker image
> pins `python:3.12-slim` for this reason — if you do not have 3.12 locally, run the
> ML service with `docker compose up -d ml-service` instead.

### 1. Install and configure

```bash
pnpm install
cp .env.example .env          # Windows: Copy-Item .env.example .env
```

Generate real secrets and paste them into `.env`:

```bash
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

`ENCRYPTION_KEY` must be exactly 64 hex characters — it is the AES-256-GCM key used to
encrypt stored GitHub tokens. The API refuses to boot if it is missing or the wrong length.

### 2. Start infrastructure

```bash
pnpm docker:up          # postgres + redis
pnpm db:push            # apply the Prisma schema
pnpm db:seed            # demo org, users, policy
```

### 3. Run the apps

```bash
pnpm dev                # web :3000  +  api :4000
```

| Service | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:4000/api/v1 |
| API docs (Swagger) | http://localhost:4000/docs |
| ML service | http://localhost:8000/docs |

### 4. ML service

```bash
cd apps/ml-service
python -m venv .venv
.venv\Scripts\Activate.ps1          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

python scripts/train.py             # writes artifacts/*.joblib + model_report.json
uvicorn app.main:app --reload --port 8000
```

Or via Docker, which trains during the image build so the container serves models
the moment it starts:

```bash
docker compose up -d ml-service
```

Retraining means rebuilding the image:

```bash
docker compose build ml-service && docker compose up -d --force-recreate ml-service
```

Model artifacts are baked into the image on purpose and **not** mounted as a volume.
A named volume over `/app/artifacts` would be seeded from the image exactly once and
never refreshed, so every later rebuild would keep serving the original model while
looking like a successful deploy. Only per-organization models, which are genuine
runtime state, get a volume (`/app/org-models`).

### What the bootstrap model is and is not

With no labelled review history, the service trains on a synthetic dataset whose
labelling rule is written out explicitly in `scripts/generate_dataset.py`. Those
artifacts are tagged `is_baseline=True`, their confidence is capped at 0.70, and the
UI presents them as a heuristic baseline rather than learned insight.

Measured on the bootstrap data: ROC AUC 0.854, 5-fold CV 0.805 ± 0.017, Brier 0.120,
review-time median error 4.7 min. Risk scores order sensibly (a tested typo fix
scores ~10, an untested auth bypass ~72, a payment change with two critical findings
~90), but the distribution is bimodal — genuinely mid-risk changes tend to land in
HIGH rather than MEDIUM. That is a known limitation of a synthetic label function and
the reason per-organization retraining exists; it kicks in at
`ML_MIN_SAMPLES_FOR_ORG_MODEL` (default 200) labelled pull requests.

The issue clustering and issue-type models are likewise fitted on synthetic finding
text and are refitted on real `StaticFinding.message` values per organization.

---

## GitHub OAuth setup

1. github.com → Settings → Developer settings → **New OAuth App**
2. Homepage URL: `http://localhost:3000`
3. Authorization callback URL: `http://localhost:4000/api/v1/auth/github/callback`
4. Copy the client ID and secret into `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`

Scopes requested: `read:user`, `user:email` for identity and `repo` for private diffs. Drop
`repo` to `public_repo` if you only need public repositories.

---

## Common commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | web + api in watch mode |
| `pnpm build` | production build of api + web |
| `pnpm typecheck` | TypeScript across every workspace |
| `pnpm lint` | ESLint across every workspace |
| `pnpm test` | unit + integration tests |
| `pnpm db:migrate` | create and apply a migration |
| `pnpm db:studio` | Prisma Studio |
| `pnpm docker:up:all` | full stack including the ML service |
| `pnpm ml:train` | retrain ML models |
| `pnpm --filter @codelens/api worker` | dedicated background worker process |
| `pwsh -File apps/api/test/verify-review-sessions.ps1` | review workspace regression suite |
| `pwsh -File apps/api/test/verify-ai-review.ps1` | AI review path regression suite |

Analysis, repository indexing and organization-wide GitHub sync are queued, not inline. In
development `RUN_WORKERS_IN_API=true` runs the consumers inside the API. In production set it
to `false` and run the worker as its own process, so a multi-minute analysis cannot compete
with request handling for the event loop. See [apps/api/README.md](apps/api/README.md) for the
job contract and polling model.

---

## Security notes

- GitHub tokens are encrypted at rest with AES-256-GCM; they are never logged or returned by the API.
- Diffs pass a secret-scanning pass **before** any content is sent to an LLM provider.
- Static analysis runs in a sandbox with no network access and a read-only filesystem.
- Prisma middleware enforces `organizationId` scoping, so a forgotten `where` clause cannot leak across tenants.
- Inbound GitHub webhooks are verified by HMAC signature.
- `post_github_comment` is the only tool with external write access and requires both a `REVIEWER` role and an explicit org policy opt-in.

## Status

The backend runs end to end. A seeded pull request goes through all eleven tools and produces
real static-analysis findings, an ML risk score with SHAP-style attributions, retrieved
repository context, and a persisted report — via the queue and via the inline path. On top of
that sits the review workspace: human verdicts, a policy-driven merge gate, threaded comments
that can clear findings from that gate, and time-limited external share links. Human verdicts
feed back into the ML training labels, so the risk model improves from review outcomes rather
than staying frozen at its bootstrap weights.

The AI review path is wired, hardened and verified: generation, schema validation with a single
repair attempt, evidence filtering that drops fabricated citations, policy reconciliation that
overrides the model, persistence, and classified degradation for every provider failure mode.

What that verification did and did not cover, precisely:

- **Covered end to end**, against a local provider double that speaks the OpenAI wire format so
  the real adapter, retry logic, validation, repair loop, evidence filter and persistence all
  execute unchanged: the enabled happy path, fabricated and uncited evidence being dropped, the
  model's APPROVE being overridden to REQUEST_CHANGES by policy, a malformed response being
  repaired once, and seven provider failure modes each degrading only the AI stage while static
  findings, ML risk, RAG context and the merge gate stay intact. 157 assertions.
- **Not covered: whether a real model writes a *good* review.** No provider key is configured, so
  no real inference has ever run. Set `OPENAI_API_KEY` (or the Anthropic / OpenRouter
  equivalent) and re-run `apps/api/test/verify-ai-review.ps1 -Section enabled`; the assertions
  check structure, evidence grounding and policy handling, but judging the prose is a human job.

Remaining gap: **`apps/web` does not exist yet.** The API and its OpenAPI document are the only
interface.

See the implementation blueprint for the phase-by-phase plan, and
[apps/api/README.md](apps/api/README.md) for the AI review contract and the verification
harnesses.
