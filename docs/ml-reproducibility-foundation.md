# ML reproducibility/security prerequisite

Starting revision: `cd3bd1a4266b268f995b1186047faa92225b1788`. This is an
internal inference prerequisite, not ValidationMlAssessment/Comparison, BASE
feature extraction, a queue, a user-facing ML validation API, or a frontend.
No database migration, historical prediction rewrite, model retraining, new
feature, RAG, AI re-review, or GitHub mutation is included.

## Model meaning

The target is `was_risky`: a historical/synthetic risky-or-needs-changes
classification signal. It is not vulnerability/exploit probability, probability
that a patch is unsafe, or proof of safety. Existing default image builds use
6,000 synthetic examples, seed 42, heuristic-generated labels and label-conditioned
text. Current training compares logistic regression, random forest and boosting;
sigmoid calibration is used for bootstrap data and isotonic calibration for CSV
data. Test-set model selection limits independent holdout claims. No real-world
quality or causal patch-improvement claim is established here. Confidence remains
the existing distribution-distance/boundary heuristic, not a confidence interval.

## Strict contract and feature schema

Internal-only POST `/internal/risk/v1` and `/internal/risk/v1/pair` use
`codelens-risk-inference-v1` and `codelens-risk-features-v1`. Pair inputs are
`original` and `patched`; single input is `features`. The optional organization
ID is an opaque bounded alphanumeric/dash/underscore selector, not an artifact
path. Arbitrary model, endpoint, explanation and unknown fields are rejected.
All 15 features are required; booleans, numeric strings, missing values, extras,
non-finite values and JSON duplicate keys are rejected. No silent defaults.

Canonical numeric order and bounds:

| Feature                   | Type/range                                     | Meaning                                           |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| lines_added               | integer 0..1,000,000                           | additions in analyzable changed files             |
| lines_deleted             | integer 0..1,000,000                           | deletions in analyzable changed files             |
| files_changed             | integer 0..1,000                               | analyzable changed-file count                     |
| number_of_commits         | integer 0..10,000                              | original PR commit count                          |
| complexity_delta          | finite -1,000,000..1,000,000; 0.001 resolution | existing complexity proxy delta                   |
| security_findings_count   | integer 0..10,000                              | severe SECURITY findings attributable to change   |
| dependency_changed        | integer 0 or 1                                 | existing changed-path indicator                   |
| test_files_changed        | integer 0 or 1                                 | test-path indicator, not test count/pass          |
| auth_file_changed         | integer 0 or 1                                 | authentication path indicator                     |
| database_file_changed     | integer 0 or 1                                 | database path indicator                           |
| config_file_changed       | integer 0 or 1                                 | configuration path indicator                      |
| payment_file_changed      | integer 0 or 1                                 | payment path indicator                            |
| previous_risky_file_count | integer 0..1,000                               | changed paths in frozen historical risky-path set |
| title_text                | string, <=300 Unicode code points              | frozen original title text                        |
| commit_text               | string, <=2,000 Unicode code points            | frozen ordered commit text                        |

Text uses NFC, collapses ASCII whitespace, trims ASCII spaces and rejects
remaining ASCII controls; both pre/post-normalization length bounds apply.
Full JSON request bytes are bounded to 32 KiB, including escaped Unicode.
Metadata is data, never instructions. This normalizer is not a secret redactor;
future server-side feature extraction must supply appropriately sanitized text.
Zero files with nonzero churn and risky-file count exceeding changed-file count
are rejected. These are admission bounds, not assertions about the model's
training distribution. Existing preprocessing still derives its seven ratios
and applies fitted scalers plus TF-IDF/SVD; no new model inputs were introduced.

## Trusted artifact identity

Operator-configured shared `models.joblib` and per-organization `<id>.joblib`
locations require a sidecar `.manifest.json`. Regular files only; artifact <=256
MiB, manifest <=8 KiB. The manifest schema and whole-artifact SHA-256 are checked
before deserializing the same byte buffer. No request path/URL or remote artifact
download exists. Operators must protect artifact directories/manifests and mount
them read-only. SHA-256 identifies bytes; it does **not** make malicious joblib
safe. Joblib is executable, trusted operator-controlled serialization.

`scripts/manifest_artifact.py ARTIFACT --trusted-operator-artifact` creates a
manifest for an already trusted artifact, refuses overwrite, and does not train.
The normal Dockerfile adds manifest creation after its existing unchanged training
step. Runtime proof instead reused a pinned release image's artifact without training.

Identity includes artifact SHA-256, model name/version, baseline flag, schema,
contract, band policy, implementation version/digest, runtime fingerprint,
operator runtime/image label, and organization selection scope. Preprocessing and
calibration digests are domain-separated identities binding the exact containing
artifact digest, component role and qualified class. They are **not standalone
serialized-component hashes**. Re-pickling sklearn objects proved load-order
dependent in the first runtime attempt and was deliberately removed. Parent
artifact bytes remain authoritative. Runtime fingerprint includes Python/platform
and installed inference-library versions; an operator image label is not attestation.

Shared selection occurs when an organization artifact is absent. An existing
invalid organization artifact/manifest fails closed, never falls back. Selection
happens once per single/pair operation, under a registry lock; at most four loaded
bundles are cached. Both halves retain the same selected in-memory bundle across
reload. Terminal identity is common to both observations. A changed artifact on
a later operation is a new identity; the client can require an expected digest.

## Band, precision and response

Python is authoritative for `risk-band-policy-v1`: LOW below 35; MEDIUM at 35;
HIGH at 60; CRITICAL at 85, except confidence below 0.35 caps CRITICAL to HIGH.
TypeScript validates but never replaces the service band. Legacy tools, persistence
and report rendering now preserve that band too. Previously stored rows are untouched.

Strict observations use integer `scoreTenths`, `probabilityMicros` and
`confidenceMillis`; score is service-rounded to 0.1 point. Existing probability
clamping to 0.005..0.995 is unchanged. Warnings are bounded machine categories.
No SHAP/explanations, timestamps, latency, raw exception, text or filesystem paths
are included in strict results. Canonical UTF-8 JSON sorts object keys, preserves
array order and excludes non-finite values; result SHA-256 excludes its own digest.
Client checks strict schemas, feature/result digests, scope and optional expected
artifact digest, and retains score precision and authoritative band.

AVAILABLE contains identity and observations; UNAVAILABLE contains only contract
and bounded category, never score-zero placeholders or a successful partial pair.
A no-change vector returns `NO_MODEL_ASSESSMENT`, not fabricated certainty. An
AVAILABLE zero is representable and consumer-tested separately from unavailability;
the unchanged calibrated model clamps positive-class probability, so a natural
strict model-inferred zero was **not** observed or manufactured.

## Security, admission and reload

The default Compose ML service has internal exposure only, no published host port.
Any developer host mapping must be an explicit loopback-only local override.
Private networking is the trust boundary, not user authentication or CORS.
Production operators must restrict network peers and prohibit untrusted access.
`/models/reload` is disabled by default; explicit `ML_ENABLE_OPERATOR_RELOAD=true`
is operator-only on a protected network. Reload clears the strict registry for new
operations; already selected pairs retain their original bundle. Invalid new
manifests fail closed. Process restart is the preferred deployment mechanism.

Strict single/pair admission is one operation per process, no pending-work queue;
body-read budget 2 seconds, inference response budget 10 seconds, response <=16 KiB.
The API client aborts transport/body reads, caps its timeout at 15 seconds and
bounds streamed response bytes. Errors use stable categories, no raw exception
or validation input echo. Timed-out synchronous work is **not forcibly killed**;
it retains admission until settlement. A permanently hung estimator requires
operator process/container replacement. This is not hostile execution isolation.
Admission is process-local and only covers the new strict endpoints; legacy
endpoints do not acquire the strict admission slot. Do not claim a service-wide
legacy concurrency/security upgrade. Strict requests use trusted fitted objects
with bounded data, never candidate scripts or tests/builds.

## Backward compatibility

Legacy `/predict/risk` remains separate, as do review-time/neighbour calls,
tolerant feature defaults, existing legacy error handling and static fallback.
ReviewRun persistence retains integer rounding; no historical rows are rewritten.
Its intermediate unavailable-tool placeholders are not reused by strict inference.
The scoped band correction prevents Python's confidence cap from being undone by
TypeScript, tool output, database persistence or rendered report text.
No new ValidationRun orchestration, metadata freezing or BASE diff extraction exists.

## Verification and runtime evidence

New isolated project: `codelens_phase3f_ml_foundation_20261005`.
Container: `codelens_phase3f_ml_foundation_20261005-ml-service-1`.
Final proof image: `sha256:442ff3602680bf27d75272bcdb04a2915370eca26f2636750d085055d39279cb`.
Network: `codelens_phase3f_ml_foundation_20261005_ml-proof` (internal).
No volumes, host ports, provider credentials or existing runtime resources reused.
The trusted artifact came from certified release image
`sha256:d82219744ac158acb645a72198d97e1580de07be2f73a9b6cddc468313ffcad2`.
Only new proof containers/images were built/restarted. No model training/download.

Observed identities:

- Artifact: `4652bec9214db4ede72bc26f6c286787178a3125eb028dd0ef38bdc1314117f4`.
- Preprocessing: `6f20827a9fb8cc780d2f45783bff288b2dd29bc505c540895954e7f820b9a953`.
- Calibration: `92ee6d47817ea7eebfa214539de251cdee6d1a272b92ed816cd58a48f4e8d859`.
- Input: `af5cf5a736e87287b2682788a05e5f52d70c6a94d2820e6007ee39b5192634e7`.
- Pair result: `2d95b253c7eaf1102c4cba6b5d16048af81e9c6b1b841f370148fdb069cb8321`.

In the final local runtime, 26 repeated singles and 26 repeated identical pairs
serialized identically. After service restart the same identities/result survived.
Observed scoreTenths=340 (34.0), band LOW, probabilityMicros=340243,
confidenceMillis=700, bootstrap xgboost. A second handcrafted feature payload
scored 27.0 under the same identity; this is primitive input/output evidence,
not BASE reconstruction or evidence that a patch is safer. Real-artifact primitive reload between
halves retained its pin. Organization artifact selection, invalid-org fail-closed
and artifact corruption rejection used temporary copies of this trusted artifact.
Malformed/coerced/oversized/NaN/Infinity inputs were rejected over HTTP.

A separate test process used a deliberately shortened deadline and delayed fake
engine to prove timeout, retained admission/BUSY and synthetic-error sanitization.
That is fault-injection transport evidence, not natural model slowness or hard
estimator termination. The compiled API client passed real strict/legacy inference,
artifact mismatch and outage checks on the internal proof network. No full new
queued ReviewRun was executed; its regressions were tested, not claimed as live
analysis. Test driver remains outside production ML Docker COPY inputs.

Focused Python and TypeScript tests cover strict fields/versions/bounds, artifact
and component identities, reload selection, invalid outputs, all band thresholds,
precision, no-change, unavailable/zero distinction, sanitization and admission.
Final verification: workspace 736 passed and 7 existing platform skips
(including 358 API tests and 20 database lifecycle tests); Python 84 passed,
with existing deprecation warnings. Prisma validation/generation, sequential
workspace typecheck, package/API/web production builds and `git diff --check`
passed. New TypeScript/documentation files pass Prettier and new Python files
pass Ruff. Touched legacy files retain their pre-existing formatting failures;
main.py retains its pre-existing UP035 debt. Known walkthrough risk drift is
untouched; no browser walkthrough or new queued analysis is claimed.
Scoped credential-pattern scan across the 18 proposed files found zero matches;
isolated service logs contained zero tested synthetic markers/tracebacks. This
is not universal secret non-leakage. No provider request/GitHub mutation.

## Frozen proposed inventory

Exactly 18 files; no migration or lockfile change:

- apps/api/src/analysis/ml-band-persistence.test.ts
- apps/api/src/analysis/report-writer.service.ts
- apps/api/src/mcp-tools/tools.factory.ts
- apps/api/src/ml/ml.service.ts
- apps/api/src/ml/strict-risk-client.test.ts
- apps/api/src/ml/strict-risk-client.ts
- apps/ml-service/Dockerfile
- apps/ml-service/app/main.py
- apps/ml-service/app/strict_risk.py
- apps/ml-service/app/strict_risk_http.py
- apps/ml-service/scripts/manifest_artifact.py
- apps/ml-service/tests/runtime_strict_risk.py
- apps/ml-service/tests/test_strict_risk.py
- docker-compose.yml
- docs/ml-reproducibility-foundation.md
- packages/shared/src/contracts/index.ts
- packages/shared/src/contracts/ml-strict.test.ts
- packages/shared/src/contracts/ml-strict.ts

Ignored local proof material remains `.compose.ml-foundation.local.yml`,
`.codelens-tmp/ml-foundation/` (Dockerfiles, client driver/compiled copies) and
`.venv/`. No credentials, generated reports or screenshots are proposed.
All nine migrations and lock remain unchanged. Baseline SHA-256 remains
`e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.
No files are staged; starting HEAD remains unchanged. Proposed commit:
`feat(ml): add bounded artifact-pinned risk inference`.

## Claim boundaries

Scoped prerequisite deterministic checks and isolated local-artifact runtime
verification: PASSED. Ready for review, not committed or pushed. A natural
model-inferred zero and full new queued ReviewRun were not claimed; their
consumer/persistence compatibility boundaries are distinguished above.

Scoped deterministic/local-artifact stability is proven, not universal cross-platform
bitwise reproduction, production semantic ML quality, trustworthy patches,
hostile multi-tenant isolation, exactly-once inference or universal secret safety.
Phase 3C real Gemini tool/evidence remains PARTIALLY VERIFIED; final grounded
response/citations and multi-turn remain NOT VERIFIED. This prerequisite does not
alter those claims. ValidationMlAssessment product implementation is NOT STARTED.
