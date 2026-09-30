# Portfolio material

Resume bullets, spoken pitches and repository metadata for CodeLens Enterprise.

---

## Resume bullets

ATS-friendly: plain text, no tables or graphics, concrete technologies spelled out, one
quantified outcome each.

> **Built a full-stack AI and ML code review platform** as a pnpm monorepo (NestJS 11, Next.js 15,
> React 19, TypeScript, Prisma, Postgres with pgvector, Redis, BullMQ, Python FastAPI), orchestrating
> 11 analysis tools through a dependency-ordered DAG that produces static-analysis findings, a
> calibrated ML risk score, retrieved repository context and an AI review narrative for every GitHub
> pull request.

> **Designed and trained the ML risk engine** with scikit-learn and XGBoost — isotonic-calibrated
> risk classification with SHAP attribution, ridge regression on a log-transformed target for
> review-time intervals, nearest neighbours for similar historical pull requests, and KMeans
> clustering over finding text — and found six model defects by reading the training report rather
> than trusting it, including a review-time regression scoring R-squared of -286 and a TF-IDF feature
> space of 6,000 text columns that drowned out 20 numeric features.

> **Engineered the AI layer to be evidence-grounded rather than a model wrapper**, with Zod schema
> validation, a single bounded repair attempt, an evidence filter that drops any security finding
> citing a tool-run id the pipeline never issued, and policy reconciliation that overrides a model
> recommending approval of a critical change; verified 157 assertions across seven distinct provider
> failure modes using a local double speaking the OpenAI wire protocol.

> **Ran browser and security verification that found and fixed defects unit tests had missed**,
> including credentials leaking into the URL through a pre-hydration form submission, a secret
> scanner that silently detected nothing on diff-reconstructed content, and static-analysis findings
> anchored to wrong line numbers by a global counter; hardened the code and locked the behaviour in
> with deterministic package tests, isolated runtime contract checks and real browser walkthroughs.

### Shorter variants, if space is tight

> Built an AI/ML code review platform (NestJS, Next.js, Prisma, Postgres/pgvector, Redis/BullMQ,
> Python/FastAPI): 11-tool analysis DAG producing static findings, XGBoost risk scores with SHAP
> attribution, pgvector RAG context and a schema-validated AI review. See verification.md for current evidence and credential boundaries.

> Engineered evidence grounding for the LLM layer: schema validation, bounded repair, an evidence
> filter that drops uncited security findings, and policy override of unsafe recommendations —
> verified across 7 provider failure modes.

---

## 30-second pitch

> CodeLens Enterprise is a code review platform for GitHub pull requests. When a reviewer opens a
> pull request, they get a risk score with the reasons behind it, static-analysis findings anchored
> to the exact lines they're about, the repository context the change actually touches, and an AI
> summary — and then a merge gate that tells them whether this can ship and why not.
>
> The thing I care about most is that it isn't an LLM wrapper. Four independent evidence sources are
> assembled before any model is called, and the model's output is schema-validated and
> evidence-filtered afterwards. If it cites a tool run that never happened, the finding is dropped.
> If it recommends approving a change with a critical security finding, policy overrides it and
> shows you that it did. Pull the API key out entirely and you still get findings, a risk score and
> a merge gate — it degrades that one stage and tells you which one.

---

## 2-minute demo script

Setup beforehand: `pnpm db:reset-demo`, all services up, signed out, browser at
`http://localhost:3000/signin`.

**0:00 — Sign in** *(`owner@acme.dev` / `CodeLensDemo2026`)*

> Multi-tenant, four roles. The access token lives in memory only, never `localStorage` — one bad
> dependency shouldn't become a stolen session that outlives the tab. Refresh goes through an
> httpOnly cookie.

**0:15 — Dashboard**

> One repository, two open pull requests, one CRITICAL. Note it says *"1 of 2 pull requests have a
> completed risk prediction"* — it's specific about what it does and doesn't know.

**0:25 — Pull requests**

> PR #415 reads *not analysed*, with dashes rather than invented zeros. PR #412 is the one we care
> about: `+26 −5` across 4 files, risk 91 CRITICAL.

**0:35 — Open PR #412 → the review workspace** *(the screen the product exists for)*

> Top right: risk 91 CRITICAL, run COMPLETED, and four capability dots — static, ML risk, context,
> AI review — so you can see which stages actually ran.
>
> The layout is deliberate. Merge gate first, because it answers "can this ship". Then the verdict
> controls that act on that answer. Then the evidence that explains it. Verdict buttons used to be
> above the gate, which put a control above the state it changes.

**0:55 — The merge gate**

> Blocked, three reasons. Zero of two required approvals — two, not one, because this change touches
> payment and database code. Three unresolved findings at or above HIGH. And *"no test file changed
> while 31 lines of code did"* — that 31 is computed from the diff, not asserted anywhere.
>
> Risk 91 is listed as *advisory*, not blocking. A probabilistic score shouldn't hard-block a merge.

**1:15 — The AI review**

> Recommendation: request changes, 82% confidence. The CRITICAL finding points at
> `refund.service.ts:69` — that's the `$executeRawUnsafe` line, and the code block underneath is a
> suggested parameterized fix.
>
> *"Backed by 1 tool run."* Not the id — the count. That finding cites a static-analysis run that
> actually happened. If it had cited a run id the pipeline never issued, the finding would have been
> dropped before it reached this screen.

**1:35 — Findings → Discuss → comment**

> Findings carry a line and a snippet that match. Comments anchor to a finding, and resolving a
> finding-linked thread clears it from the merge gate. That's how a human overrides an analyzer —
> visibly, with their name on it, rather than by suppressing a rule.

**1:50 — Share**

> Time-limited external link, read-only. Open it in a private window: same findings, ordered
> correctly by severity, plus the heuristic-baseline warning on the risk score. No provider, no
> model name, no token usage, no cost, no comments, no user ids. It's an allowlisted payload, not
> the workspace with fields deleted — a denylist starts leaking the moment someone adds a field
> upstream.

**Closing line**

> Everything you just saw survives the AI being unavailable. That was the design constraint.

---

## 5-minute technical explanation

**Frame it (30s).** Code review has two failure modes: reviewers miss things, and reviewers drown.
The interesting problem isn't generating review text — a model does that adequately. It's producing
a review a senior engineer will *trust*, which means every claim has to be traceable to something
that actually ran.

**The four layers and why they're separate (60s).** Static analysis is fully deterministic:
ESLint, Semgrep, `npm audit`, plus two in-process analyzers, scoped to the diff. The ML risk engine
is reproducible per model version: calibrated score, SHAP-attributed reasons, review-time interval,
nearest historical PRs. RAG context is reproducible per index version: the architecture docs,
conventions and tests the change actually touches. Only then does the LLM run, and its job is to
rank and explain those three — not to create evidence.

That separation is the whole architecture. It's what lets the product degrade one stage instead of
going dark, and it's why the merge gate can be deterministic while the narrative is probabilistic.

**Orchestration (45s).** Eleven tools in a DAG, order resolved from declared dependencies. Each run
is persisted as a `ToolRun` with status, duration, cache-hit state, token usage, cost and a redacted
error — so the provenance panel in the UI is a direct rendering of that table. Analysis is queued
through BullMQ with progress polling; a multi-minute run can't compete with request handling for the
event loop.

Declaring dependencies rather than hardcoding order is what caught a real bug: the report was being
generated before the risk prediction it was supposed to contain, and because it persisted
successfully with a null score, nothing failed. It just produced a review with no risk in it.

**Evidence grounding, concretely (60s).** The prompt carries the set of valid `ToolRun` ids as the
citable evidence set. The response is extracted as JSON, Zod-validated, and given exactly one repair
attempt with the validation error fed back. Then the evidence filter: any SECURITY or CRITICAL
finding citing an id the pipeline never issued is dropped, and the drop is counted in
`droppedFindingCount`. Then policy reconciliation: a model recommending APPROVE on a change with a
CRITICAL finding is overridden to REQUEST_CHANGES, with the reasons shown rather than applied
silently.

Provider failures are classified, not collapsed. Rejected key, model not found, rate limited,
provider down, context too long, unparseable, schema-invalid — seven distinct states, each asserted
with a correct `retryable` flag, and the run comes out `PARTIAL` rather than `FAILED`.

**How I verified it, and what that found (90s).** Deterministic tests plus isolated runtime and browser checks; current totals are in verification.md. The AI path runs
against a local double speaking the OpenAI wire format, so the real adapter, retry logic, JSON
extraction, validation, repair loop, evidence filter and persistence all execute unchanged — because
the failure modes worth testing can't be produced on demand from a real provider.

Three findings I'd highlight. First, the sign-in form submitted as a GET before React hydrated, so a
submit during page load put the password in the URL and in history. Found by driving a real browser,
not by unit tests. Second, the secret scanner was silently detecting nothing: it indexed
diff-reconstructed content by absolute line number, so for a hunk starting at line 55 every lookup
ran past the end of a 13-element array — and it reported success. Third, static findings were
anchored by `touchedLines[findings.length]`, a global counter, so a SQL-injection finding sat three
lines above the call it described and a finding in one file renumbered findings in the next.

Fixing the third exposed a fourth: with correct line numbers, two distinct raw-SQL rules landed on
the same line and the dedupe key collapsed them, dropping the missing-tenant-filter finding.
Parameterizing the query fixes the injection and leaves the cross-tenant read, so those are two
defects, not one.

**What I'd say about the limits (35s).** No real LLM inference has ever run — no provider key. The
AI path is verified structurally; whether a real model writes a *good* review is a human judgement
I haven't made. The ML models are trained on synthetic data with an explicit labelling rule, tagged
`is_baseline`, confidence capped at 0.70, and the UI says so on the risk panel. The quoted AUC of
0.854 describes a synthetic label function, not real pull requests. Browser QA covered Chrome only,
and there's been no screen-reader testing or security audit.

I'd rather say that than show a number and let someone assume it means more than it does.

---

## GitHub repository metadata

### Description

> Enterprise AI + ML code review platform for GitHub PRs. NestJS + Next.js + Python monorepo: an
> 11-tool analysis DAG, XGBoost risk scoring with SHAP attribution, pgvector RAG, and an
> evidence-filtered LLM layer that drops uncited findings.

*(238 characters — under GitHub's 350 limit, and the point lands in the first clause.)*

### Alternative, shorter

> AI + ML code review for GitHub pull requests. Static analysis, calibrated ML risk scoring, RAG
> repository context, and an LLM layer that can only cite evidence the pipeline produced.

### Topics

```
code-review
static-analysis
machine-learning
rag
llm
nestjs
nextjs
typescript
python
fastapi
xgboost
scikit-learn
pgvector
postgresql
prisma
redis
bullmq
monorepo
devtools
ai-agents
```

Twenty topics — GitHub's maximum. Ordered so the first row reads as the problem domain rather than
the framework list, because that is what a search lands on.

### Suggested repository settings

- **Homepage:** leave blank until deployed; a dead link is worse than none.
- **Pin** this repository on your profile, so the README's screenshots are the first thing seen.
- **Releases:** tag the current state `v0.1.0-demo` with the limitations section as release notes.
  It signals honesty about maturity better than an unversioned `main`.
- **Social preview image:** use `docs/screenshots/review-workspace.png` — it shows the merge gate,
  the AI narrative and the risk score in one frame.
