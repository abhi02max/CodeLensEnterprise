# Interview notes

The questions this project invites, answered with specifics. Where the honest answer is "I don't
know" or "that isn't verified", it says so — those answers are load-bearing, not hedging.

---

## 1. Why is this not just an OpenAI API wrapper?

Because the model is the last stage, not the system, and three concrete mechanisms enforce that.

**It runs fourth, on evidence it did not create.** Before any prompt is built: the diff is fetched
and parsed, five analyzers run over it, 13 numeric features plus two text features are extracted, a
calibrated risk model scores them, and a hybrid retriever pulls the repository context the change
touches. The prompt is assembled *from* those outputs. The model's job is to rank and explain them.

**Its output is filtered, not trusted.** The prompt carries the set of valid `ToolRun` ids as the
citable evidence set. Any SECURITY or CRITICAL finding that cites an id the pipeline never issued is
dropped and counted in `droppedFindingCount`. This is tested by a scenario that deliberately returns
a plausible-looking cuid: `cmufabricated000000000000`. The finding does not reach the database.

**Policy can override it.** A model recommending APPROVE on a change with a CRITICAL finding is
reconciled to REQUEST_CHANGES, and `policyOverridden` plus `policyReasons` are persisted and shown.
The model does not get the final word on whether something can merge.

**The test that settles it.** Remove the API key entirely. The product still produces static
findings, a risk score with attributions, retrieved context, change metrics, threaded review and a
functioning merge gate. `aiReviewStatus` becomes `SKIPPED` with a non-retryable reason, one panel
explains the gap, and nothing else changes. A wrapper has nothing left when the provider is gone.

**What a wrapper would have been.** Send the diff, render the markdown. That was maybe two days of
work. The other 95% of this codebase is the evidence pipeline, the tenant model, the queue layer, the
gate, and the verification — which is where the actual engineering questions live.

---

## 2. How does the ML risk scoring work?

**Features (13 numeric + 2 text).** `lines_added`, `lines_deleted`, `files_changed`,
`number_of_commits`, `complexity_delta`, `security_findings_count`, `dependency_changed`,
`test_files_changed`, `auth_file_changed`, `database_file_changed`, `config_file_changed`,
`payment_file_changed`, `previous_risky_file_count`, plus `title_text` and `commit_text`.

Two of those carry most of the signal and both are *computed*, not metadata:
`security_findings_count` counts only non-preexisting SECURITY findings at HIGH or above — so
inherited problems in a legacy file don't inflate the risk of whoever edited one line — and
`previous_risky_file_count` is derived from this repository's own history of trouble, making it the
only feature encoding the organization rather than a generic heuristic.

The feature list and its ordering are mirrored between `packages/shared/src/ml-features.ts` and
`apps/ml-service/app/features.py`, with a parity test that fails the build if they drift. Silent
column reordering across a language boundary is the kind of bug that produces plausible garbage.

**Pipeline.** Numeric features are scaled; `title_text` and `commit_text` each go through a TF-IDF
vectorizer capped at 800 features with 1–2 grams, then TruncatedSVD. An XGBoost classifier ranks, and
`CalibratedClassifierCV` with isotonic regression turns the ranking into a probability. Score is
`probability × 100`, bucketed into LOW / MEDIUM / HIGH / CRITICAL. SHAP produces per-feature
attributions, which the UI renders as the "Why" list with human labels and directions.

**Three deliberate modelling decisions worth defending:**

*`scale_pos_weight` is not set*, against the conventional advice for imbalanced data. Reweighting
shifts the very probabilities the calibration step is responsible for correcting. Ranking comes from
the model; probability correctness comes from calibration. Doing both corrupts the second.

*Three classifiers are trained and compared* — logistic regression, random forest, XGBoost — the
best is selected on measured metrics, and an eighth training step runs a bagging-versus-boosting
experiment. That comparison table is exposed through the API rather than left in a notebook. An
enterprise buyer asking "why XGBoost" deserves the measured answer, and cross-validated AUC on the
selected model guards against a lucky split.

*Review time is fitted with a penalty, in log space, and always returns an interval.* The target is
`log1p(minutes)` because a handful of very long reviews otherwise dominate the loss and drag every
prediction upward. The first attempt used plain `LinearRegression` and scored R² of **−286** — far
worse than predicting the mean — because the transformed matrix has ~6000 columns (mostly TF-IDF)
against ~4800 training rows, so OLS is underdetermined: it fits the training set exactly, produces
enormous coefficients, and the predictions explode after `expm1`. `RidgeCV` picks the L2 penalty by
cross-validation and keeps the coefficients bounded. The residual sigma becomes a prediction
interval, because a bare point estimate for "how long will this review take" is misleading.

**How it learns.** Human verdicts write training labels: submitting a review sets `wasRisky`,
`firstReviewedAt` and `actualReviewMinutes` on the pull request. Per-organization retraining triggers
at 200 labelled pull requests (`ML_MIN_SAMPLES_FOR_ORG_MODEL`).

**The honest caveat.** With no review history, the model trains on synthetic data whose labelling
rule is written out in `scripts/generate_dataset.py`. Those artifacts are tagged `is_baseline=True`,
confidence is capped at 0.70, and the risk panel says *"Produced by a heuristic baseline, not a model
trained on this organization's review history. Treat it as weak evidence."*

Measured on that synthetic data: ROC AUC 0.854, 5-fold CV 0.805 ± 0.017, Brier 0.120, review-time
median error 4.7 min. **That describes a synthetic label function, not real pull requests.** Scores
order sensibly — tested typo fix ~10, untested auth bypass ~72, payment change with two critical
findings ~90 — but the distribution is bimodal: genuinely mid-risk changes land in HIGH rather than
MEDIUM. That's a known artifact of a synthetic labeller and the reason per-org retraining exists.

---

## 3. How is RAG used?

To answer "what does this change touch that the reviewer should know about", not to fetch snippets
that look topically similar.

**Indexing.** AST-aware chunking rather than fixed-size windows — a chunk is a function, class, test
case or documentation section, so it arrives with a symbol name and a kind (`FUNCTION`, `TEST_CASE`,
`DOC_SECTION`, `CONVENTION`). Vectors live in Postgres via pgvector.

Two levels of caching, because re-embedding unchanged files is the dominant cost of keeping an index
fresh. Chunk ids and reuse decisions are keyed on a SHA-256 `contentHash`, so a re-index skips
anything unchanged; and `CachedEmbeddingProvider` caches vectors under
`emb:{model}:{dimensions}:{hash}`. The model and dimension count are in the key deliberately — the
same text embedded by a different model is a different vector, and mixing them silently corrupts
search results.

**Retrieval is hybrid — four strategies, and they disagree usefully.**

| Strategy | Finds |
| --- | --- |
| `VECTOR` | semantic similarity over embeddings |
| `LEXICAL` | exact identifier matches from the diff |
| `IMPORT_GRAPH` | files that import, or are imported by, a changed file |
| `CONVENTION` | the repository's own documented conventions and existing tests for changed files |

Vector search alone reliably misses exact symbol matches: a diff calling `recordRefund` may not rank
the chunk *defining* `recordRefund` highly, because the two share little other vocabulary. A literal
identifier match finds it immediately. The import graph contributes something embeddings cannot know
at all — structural dependency.

**Why that's surfaced in the UI.** The context panel shows *which strategies agreed* on each chunk,
not just a score. "Three independent strategies agreed" is a defensible reason to read something; a
bare cosine distance of 0.83 is not. In the demo, `refund.service.test.ts` is retrieved by LEXICAL,
IMPORT_GRAPH *and* CONVENTION simultaneously — it references an identifier from the diff, imports a
changed file, and is the existing test for it.

**What it's for downstream.** Retrieved chunks are persisted as `RetrievedContext` rows tied to the
run, so you can audit what the model was grounded in after the fact. They also let the AI cite
repository conventions rather than generic best practice — the demo review references
`docs/architecture.md`'s `Result<T, E>` convention, which is why the "raw write diverges from the
Result convention" finding is meaningful rather than boilerplate.

**Limits.** The demo repository is indexed as three chunks, from which the run retrieves six
per-file context rows across two files. Retrieval quality at the scale of a real monorepo is
unmeasured, and there is no evaluation harness for retrieval precision or recall — that is a real
gap, and the honest reason is that building one needs labelled relevance judgements I do not have.

---

## 4. How does static analysis work?

Five analyzers, every one independently degradable, all scoped to the diff.

| Analyzer | Process | Notes |
| --- | --- | --- |
| `SECRET_SCAN` | in-process | runs **first** and gates the LLM call |
| `PATTERN_SCAN` | in-process | line-oriented rules; the coverage floor |
| `ESLINT` | sandboxed subprocess | skipped when the target repo has no config |
| `SEMGREP` | sandboxed subprocess | AST-based, needs valid files |
| `NPM_AUDIT` | sandboxed subprocess | needs npm on PATH |

**Why the secret scan is first and in-process.** Its result gates whether diff content may be sent
to a third party. A leaked credential forwarded to a provider *while reviewing the commit that leaked
it* would be a self-inflicted incident. It also must not depend on the sandbox or any external binary
succeeding. Findings carry a masked excerpt only — never the value — because the finding is stored in
the database and rendered in the UI, and neither should become a second copy of the credential.

**Why `PATTERN_SCAN` exists, which is the most interesting constraint here.** Semgrep matches against
an AST, which requires syntactically valid files. But reviewing a pull request means reconstructing
content from diff hunks, and a hunk is almost never valid standalone code — a changed method body
reconstructs to a method with no enclosing class, which no TypeScript parser accepts. Measured on the
demo pull request: Semgrep ran successfully over four files and matched **none** of them. Fetching
every full file would fix parsing but costs two extra API calls per changed file and is impossible
for a repository the deployment cannot reach.

So `PATTERN_SCAN` applies line-oriented patterns that don't care about surrounding syntax. It is
strictly less capable — no dataflow, no taint tracking, no cross-function reasoning — and limited to
patterns unambiguous on a single line or a small window. Semgrep stays primary when full files are
available; this guarantees a floor when they are not.

**Scoping, which matters more than it sounds.** `markPreexisting` marks findings on lines the change
didn't touch. They're kept and shown separately, and excluded from `security_findings_count`. Running
a linter over a legacy file surfaces every latent issue in it; attributing those to whoever edited one
line is both unfair and actively harmful, because it buries the findings that *are* about this change.

**The line-anchoring bug.** Reconstructed content is a *fragment* — index 0 is wherever the first hunk
starts, not line 1. `parseUnifiedPatch` always tracked the real positions, but `reconstructSides`
discarded them and returned bare strings, so an analyzer could match a line without being able to say
which line. `PATTERN_SCAN` filled the gap with `touchedLines[findings.length]` — the touched-line set
indexed by a global finding counter. Three independent wrongnesses: the counter is unrelated to the
match, it incremented across file boundaries so a finding in one file renumbered the next file's, and
two rules on one line got different numbers. On the demo PR a SQL-injection finding sat three lines
above the `$executeRawUnsafe` call it described.

The fix threads real line numbers through `reconstructSides` → `AnalyzerFile.contentLineNumbers` →
the analyzer. Live output on PR #412 now: `CRITICAL refund.service.ts:69`, `HIGH :69`, `HIGH :58`,
`MEDIUM :59` — each snippet on the line it claims.

**What the demo produces.** 4 findings on a `+26 −5` / 31-changed-line diff, feeding
`security_findings_count = 3` and a risk score of 91 CRITICAL.

---

## 5. How do the worker queues work?

Five BullMQ queues on Redis: `review-run`, `repo-index`, `pr-sync`, `github-publish`,
`model-retrain`.

**Why queued at all.** A full analysis takes tens of seconds and involves sandboxed subprocesses, an
HTTP call to a Python service and an LLM round trip. Run inline it competes with request handling for
the event loop, and one analysis degrades latency for every other user of the process.

**The contract.** `POST /pull-requests/:id/analyze` returns `202` with a job handle. The client polls
`GET /jobs/:id` for stage and percentage. A `sync: true` escape hatch runs inline and returns the
finished result — used by the verification harnesses, because polling in a test suite is a source of
flakiness rather than confidence.

**Idempotency.** The key is `pullRequestId:headSha:promptVersion:featureSchemaVersion`. An equivalent
completed run is reused rather than repeated, unless `force: true`. Including the prompt and feature
schema versions in the key matters: a prompt change should invalidate cached reviews, because the
output is a function of the prompt.

**Deployment.** `RUN_WORKERS_IN_API=true` in development keeps it to one process. In production it's
`false` and the worker runs as its own process via `pnpm --filter @codelens/api worker`, so analysis
capacity scales independently of request capacity.

**Four bugs found by running it, all of which I'd have missed by reading:**

*BullMQ silently rejects `:` in job ids* — which is exactly the separator a natural
`orgId:prId:sha` key uses. Jobs appeared to enqueue and never ran.

*`getWorkers()` is unreliable as a liveness probe.* It's the obvious call for "is a consumer
attached" and it returns inconsistent results; health had to be derived differently.

*An env override in `worker.ts` was dead code.* It set `process.env` after the config module had
already been evaluated, so the setting silently had no effect — the kind of thing that looks correct
in review forever.

*Redis with `allkeys-lru` can evict queue state.* Under memory pressure a pending job becomes one
that never existed. The eviction policy is a correctness concern for a queue, not a tuning knob.

---

## 6. What bugs did verification actually find?

Grouped by what found them, because that's the more useful lesson: each class of bug needed a
different kind of verification, and none of them were reachable by reading the code.

### Found by running the ML training and reading the report

1. **Review-time regression, R² = −286.** Plain OLS, underdetermined at ~6000 transformed columns
   against ~4800 rows, so it fit the training set exactly and exploded after `expm1`. Replaced with
   `RidgeCV` on a log-transformed target, returning an interval from the residual sigma.
2. **SVM issue-type leakage.** Target information reachable from the features; accuracy looked
   excellent and meant nothing.
3. **Isotonic calibration saturating.** Mapping nearly everything to ~0 or ~1, destroying the
   probability it was supposed to produce.
4. **TF-IDF drowning the numeric features.** ~6000 text columns against 20 numeric ones; with
   `colsample_bytree`, most candidate splits were text tokens, so the model learned from commit
   prose rather than change shape. Capped at 800 per field plus SVD.
5. **`scale_pos_weight` corrupting calibration.** The conventional fix for imbalance, actively wrong
   when a calibration layer owns the probabilities.
6. **The quality gate checked the wrong target.** The guard that was supposed to fail a bad model
   couldn't have.

### Found by running the full pipeline end to end

7. **Report generated before the risk prediction it contained.** `create_review_report` didn't
   declare its dependency on `predict_pr_risk`. It persisted successfully with a null score, so
   nothing failed — it just produced a review with no risk in it.
8. **Prisma 6 inheritance broke tenant scoping.** `extends PrismaClient` doesn't work with the
   extension API; needed composition.
9. **A lazy-import bug** that left a service holding an uninitialised client.

### Found by deliberately failing the AI provider

10. **The provider's response body leaked into `ToolRun.error`** — including echoed prompt content
    and an API key fragment, since OpenAI's 401 body quotes both.
11. **No degradation reason existed.** A failed AI stage was indistinguishable from one that was
    never configured. This is why `aiReviewStatus` (state + reason + retryable) exists at all.
12. **Unparseable responses misclassified as schema failures**, sending non-JSON into a repair loop
    that could never succeed.

### Found by testing the sharing and audit paths

13. **A share token leaked into an error body and the logs** through an un-redacted request path.
    Fixed with `redactSensitivePath`; there's now an assertion that no raw token appears in the audit
    trail.

### Found by driving a real browser

14. **Credentials in the URL.** The sign-in form submitted as a GET before React hydrated, so a
    submit during page load navigated to `/signin?email=…&password=…`. Password in the URL, in
    history, and in any access log. Fixed with `method="post"`, no `name` attributes on the
    credential inputs, and submit disabled until hydrated. Triggered in practice by a stale build
    404ing the JS chunks — which is exactly the class of failure this has to survive.
15. **Findings ordered MEDIUM above CRITICAL** on the shared page. Prisma orders enums by
    declaration position, so `severity: 'desc'` returns INFO first. Now sorted by explicit rank.
16. **Mobile tables hid the primary action.** Risk and the review link sat off-screen while the
    document reported *zero* horizontal overflow, because the table scrolled inside its own
    container. The overflow check passed and the screen was unusable. The test now measures the
    rendered position of both elements.
17. **A wall of hollow panels** on an un-analysed pull request: the "not analysed yet" card followed
    by five more cards each restating there was nothing to show, plus a "Degraded in this run" panel
    when there was no run.
18. **Demo accumulation burying the product.** Measured: document height 5222px, Discussion panel
    2544px, Share panel 1747px. The AI review and merge gate were below all of it. Fixed by bounding
    the panels and adding `pnpm db:reset-demo`; now 3020px.

### Found by fixing the line anchors

19. **The secret scanner silently detected nothing.** Same root cause as the anchoring bug: it
    indexed diff-reconstructed content *by* new-file line number, so for a hunk starting at 55 every
    lookup ran past the end of a 13-element array. It found nothing on every file whose content came
    from a diff — the normal case — and reported success. Failing closed, silently, in a security
    control.
20. **Dedupe collapsing distinct rules.** With correct line numbers, the two raw-SQL rules landed on
    the same line and the `path:line:category` key merged them, dropping the missing-tenant-filter
    finding. Parameterizing the query fixes the injection and leaves the cross-tenant read, so
    they're two defects. Dedupe now collapses only across analyzers.

### Found by looking at the data

21. **The demo fixture contradicted itself on screen.** The PR header read `+96 −23` while the merge
    gate, reading the analyzer's metrics, said 71 lines. Both numbers were hand-authored in different
    places. Now every count and every finding anchor is derived from the patch text, and the seed
    throws if an anchor moves out of a patch.
22. **38 stale `.js`/`.d.ts` files inside `packages/shared/src`**, shadowing the sources they were
    generated from.

---

## 7. What is still limited or unverified?

The list I'd lead with if asked "what's wrong with it".

### Genuinely unverified

**No real LLM inference has ever run.** No provider key is configured. Everything about the AI path
is verified structurally against a local double speaking the OpenAI wire format — adapter, retries,
JSON extraction, validation, repair, evidence filter, policy reconciliation, persistence, and seven
enumerated failure modes. What is *not* verified is whether a real model writes a useful review. That
needs a key and a human reading output, and I'd rather say so than imply the 157 assertions cover it.

**Per-organization model retraining has never run on real labels.** The trigger, the pipeline and
the artifact swap exist. 200 real labelled pull requests do not.

**One browser.** Chrome only, via Playwright. Bundled Chromium wouldn't download on this network so
the harness drives system Chrome. No Firefox, no Safari, no screen-reader testing — so I won't claim
accessibility beyond "semantic headings, text labels alongside every colour signal, and no
colour-only state".

**No security audit.** Tenant isolation is enforced by Prisma middleware and asserted in tests.
Token encryption, webhook HMAC verification, secret gating and sandboxing are implemented. None of it
has been reviewed by anyone else or penetration tested.

**Retrieval quality is unmeasured.** No evaluation harness for retrieval precision or recall. The
demo indexes three chunks; behaviour on a real monorepo is unknown.

### Known-weak by construction

**The ML models are trained on synthetic data.** The labelling rule is explicit and the artifacts are
tagged `is_baseline`, confidence-capped and labelled in the UI — but the metrics describe that
labelling function. The score distribution is bimodal, so mid-risk changes read as HIGH.

**Semgrep contributes nothing on diff fragments.** Measured: four files, zero matches, because hunks
aren't parseable. `PATTERN_SCAN` is the mitigation, and it's line-oriented — no dataflow, no taint
tracking, no cross-function reasoning.

**`npm audit` and ESLint are conditional.** npm must be on PATH; the target repo must have an ESLint
config. Both report `NOT_INSTALLED` / `SKIPPED` rather than pretending, but in the demo environment
that means two of five analyzers don't contribute.

**The demo runs on seeded fixtures.** The GitHub client, OAuth flow, webhook verification and diff
parser are real code with real tests, but the demo path does not hit github.com. End-to-end against
a live repository is untested.

### Deliberately absent

No settings, billing, onboarding, analytics charts, landing page, or in-app diff viewer. The last one
is worth naming because it's load-bearing for a demo: the UI shows a finding's line number and its
snippet, but never a numbered diff, so you can't cross-check the anchor on screen. That's the main
thing I'd build next.

---

## Questions I'd want asked

- *"Your merge gate is deterministic but your risk score is probabilistic. Why is risk advisory
  rather than blocking?"* — Because a calibrated 0.90 still means one in ten, and a hard block on a
  probability trains people to disable the gate. The three blocking reasons are all facts: approval
  count, unresolved findings above a threshold, no test file changed. Risk earns a warning.

- *"Resolving a comment thread clears a finding from the gate. Isn't that a bypass?"* — It's the
  point. The alternative is suppressing a rule, which is invisible and permanent. This is scoped to
  one finding, attributed to a person, requires a written reason, and lands in the audit trail.

- *"Why persist `PrMetrics` instead of recomputing it?"* — It's the vector the model actually saw. A
  risk score you can't reproduce isn't auditable, and retraining needs the historical features rather
  than today's re-derivation of them.

- *"What would you do differently?"* — Build the verification harnesses earlier. Almost every bug in
  §6 was found by running something, and I wrote several of those harnesses after the code they
  tested. The ML defects in particular sat in a training report I hadn't read carefully.
