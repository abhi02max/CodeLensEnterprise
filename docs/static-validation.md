# Phase 3F Static Validation Evidence

Starting certified HEAD: `caee8a3cc5a30e874216c71e182d9bcfb1a3128a`.
This is the deterministic static re-analysis slice, not ML reassessment, candidate
RAG indexing or AI re-review. It remains uncommitted pending review.

## Analyzer Audit

| Existing implementation                      | Classification        | Disposition                                                                                                                                                         |
| -------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pattern scanner                              | B: bounded adaptation | Reuse pure regex/confirmation logic; scan full source; exclude the historical dropped-guard diff-removal rule; neutralize TODO attribution. No new detection rules. |
| Secret scanner                               | B: bounded adaptation | Reuse pure detection and existing placeholder/path/entropy exclusions; scan all lines, withhold credential values, snippets and masked fragments.                   |
| Complexity estimation                        | A: pure               | Not executed in this slice. Metrics and feature extraction are not validation findings.                                                                             |
| Historical metrics assembly                  | C for this slice      | ReviewRun/diff/ML feature semantics; not invoked.                                                                                                                   |
| ESLint                                       | C                     | Subprocess and repository configuration/plugin execution; environment/tool-version dependent. Excluded.                                                             |
| Semgrep                                      | C                     | External binary or Docker fallback, temporary config, optional registry rules and environment-dependent tooling. Excluded.                                          |
| Dependency audit                             | C                     | External npm/registry operations and optional lockfile generation. Excluded.                                                                                        |
| Historical analysis runner / AnalysisSandbox | C                     | Writes temporary files/config, launches external processes, destroys directories; not used for candidate static analysis.                                           |

Historical findings have analyzer/rule ID, severity (CRITICAL/HIGH/MEDIUM/LOW/INFO),
category, nullable path/line/endLine/column, message, snippet and fingerprint.
Their fingerprint normalizes lowercase/digits/whitespace in a bounded message,
then hashes rule/path/message, omitting line. Historical runner deduplication by
rule/location and ReviewRun fingerprint uniqueness can collapse occurrences.
This slice does not change those semantics: the existing fingerprint function
is extracted byte-equivalently into a pure module and re-exported from sandbox.

Historical secret scanning normally uses touched lines; pattern scanning skips
lines over 2,000 characters. External analysis has separate tool/time/target
limits, including a default 120-second runner budget. Those controls are not
substitutes for this slice's source-only limits.

## Domain and Input Authority

One additive migration:
`20261004010000_validation_static_findings`.

`ValidationStaticAnalysis` records one immutable ORIGINAL or PATCHED analysis
per ValidationRun, organization, attempt, source/input/result digest, ruleset and
configuration identity, status/reason, count and duration. `ValidationFinding`
normalizes analyzer/rule/severity/category/path/range/message, occurrence and
finding digests, comparability, comparison class, reciprocal counterpart digest
and edited-range relation. No source/snippet/command/environment field is added.

Application, proposal revision/digest and pinned HEAD remain authoritative through
the existing immutable ValidationRun relationships. ORIGINAL is independently
reconstructed exact pinned HEAD. PATCHED is reconstructed from that same HEAD and
the accepted immutable proposal, using existing exact snapshot/reconstruction
controls. Mutable current PR source and untrusted test reports are not authority.
No database transaction spans exact Git reads or static computation.

Composite foreign keys enforce organization/run/attempt relationships. Database
triggers reject updates/deletes, late or foreign inserts, wrong source binding,
non-COMPLETE finding inserts and count overrun. Service live-fence/membership
checks surround execution and the atomic analysis/finding persistence transaction.
Historical validation runs are not backfilled or rewritten.

## Deterministic Identity

- Ruleset version: `codelens-pure-static-v1`.
- Fingerprint version: `occurrence-v1`.
- Normalization: `trim-only-v1` after shared credential redaction.
- Comparison configuration: `unique-content-then-exact-edit-mapping-v2`.
- SHA-256 ruleset digest covers pattern descriptors/confirmation functions,
  shared secret pattern descriptors, and the scanner function representations.
- SHA-256 configuration digest covers limits, full-source policy, selected
  scanners, normalization/comparison versions and excluded rules.
- Input digest hashes sorted path/content-digest pairs; separate snapshot/candidate
  digests bind the exact reconstruction used by paired validation.

Changing helper semantics requires an explicit normalization/fingerprint/config
or ruleset version change; the function digest is not a complete compiler or
transitive dependency attestation. Both sides must have identical identities.
Wall-clock duration and generated row IDs are not occurrence identity.

Occurrence fingerprint is SHA-256 of the JSON tuple
`[fingerprintVersion, analyzer, ruleId, path, redactedMatchedLine.trim()]`.
Internal whitespace and full bounded matched constructs are preserved; line
number, message and severity are not primary identity. Relevant digest hashes
the redacted construct and severity, or the bounded local window used by raw-SQL
confirmation. Finding digest includes normalized location/message/diff relation
for immutable observation integrity, not logical occurrence matching.

Credential values are replaced before occurrence/relevant hashing. They are not
used as reversible identity or exposed as masked fragments. Shared redaction can
collapse distinct values; retained secret or secret-containing matches therefore
remain INCOMPARABLE. Source/input digests are integrity metadata, not secret
identifiers or a confidentiality guarantee for low-entropy source guesses.

## Occurrence Comparison

Unique identical occurrence fingerprints match despite line movement. Relevant
content/severity equality gives UNCHANGED; a relevant change gives CHANGED.
Duplicate identical-looking constructs on either side are INCOMPARABLE, even
when they occupy different functions: this scanner has no AST identity.

Remaining unique same-rule/analyzer/path observations can match as CHANGED only
through exact disjoint edit line mapping. Replacement ranges with unequal line
counts do not establish an internal one-to-one mapping. Unmatched occurrences
are RESOLVED/INTRODUCED only against a complete compatible opposite side and
without ambiguous same-rule counterparts. A one-to-one edited-line mapping with
no same-rule observation at its opposite location can establish local absence,
despite unrelated ambiguous observations elsewhere. No fuzzy matching is used.

Incomplete status or identity mismatch makes retained comparison observations
INCOMPARABLE. Path movement is not inferred as rename: observations at different
paths are separate resolved/introduced observations, not a rename claim.
Secret-only absence can be reported when a complete opposite scan no longer
detects it; secret values retained on both sides cannot be compared unchanged.

RESOLVED means the analyzer no longer detected that occurrence, not a proven fix.
INTRODUCED means a new comparable analyzer occurrence, not proven exploitation.
Summary counts count matched pairs once; unmatched ambiguous observations count
each side separately, without inventing pairs.

`EDITED_RANGE`, `CHANGED_FILE` outside the range and `UNCHANGED_FILE` are context
labels, never filters on analyzer coverage. Existing outside-range findings remain.

## Limits and Failure Semantics

| Boundary                   | Fixed limit                                                 |
| -------------------------- | ----------------------------------------------------------- |
| Files per side             | 100                                                         |
| Source bytes per side      | 2 MiB UTF-8                                                 |
| File bytes                 | 128 KiB                                                     |
| Line / matched construct   | 2,000 characters                                            |
| Local confirmation context | At most five bounded lines / 10,016 characters              |
| Findings per side          | 500                                                         |
| Message                    | 700 characters                                              |
| Paired static computation  | 5 seconds                                                   |
| Worker memory              | 64 MiB old generation, 16 MiB young generation, 4 MiB stack |
| API page                   | Default 25, maximum 50                                      |
| Summary read               | At most 1,000 normalized rows                               |

Path traversal, encoded/absolute/Windows paths, .git components, duplicates/case
collisions, credential-bearing paths, binary/invalid UTF-8 text and source bounds
fail explicitly. Git object eligibility remains inherited from exact snapshots.
Long-line omissions return UNSUPPORTED rather than pretending full coverage.
Finding overflow returns TRUNCATED, without silently preserving a clean subset.

A fixed trusted Node worker parses source strings with empty environment/execArgv,
private discarded stdout/stderr and resource limits. It does not run repository
code/scripts, install packages, access repository files, call tools or use network.
Timeout/cancellation terminates that worker; error/exit becomes FAILED; sanitized
result validation rejects malformed/binding-mismatched output. Worker construction
or termination failure can fail the ValidationRun before static observations are
recorded, which readback explicitly distinguishes from zero findings. This is not
an OS sandbox or a universal wall-clock guarantee under host failure.

## Integration, API and UX

Static computation follows paired profile observations with verified reconstructed
inputs; profile test FAIL is a recorded observation, not an infrastructure failure.
Static status is separate from paired test outcome. No ReviewRun is fabricated;
no gate, verdict, finding resolution, proposal acceptance or application is changed.

`GET /api/v1/validations/:id/static-findings` requires authentication, current
membership and existing server-derived application/conversation authorization.
Foreign scope returns 404. UUID cursor is checked within the same tenant/run.
Strict query allows only cursor, limit, side, exact rule, severity and class;
unknown executable/config/environment fields are rejected (HTTP 422).

The workspace shows side/status/count, ruleset/fingerprint/config/source identities,
comparison summary, normalized findings, file/line, safe message, reciprocal digest
and diff relation. Side/class/severity/rule controls and bounded paging use existing
UI primitives. Files are visible per occurrence, not a new arbitrary filesystem
viewer. Missing/incomplete analyses show unavailable-comparison language instead
of zero classification counters. No static execution or patch application control
is added. Existing validation controls and safety disclaimer remain intact.

Four metadata-only audits record static start, both side completions and comparison.
Status/reason disclose failure/truncation/incomparability; source, snippets, patch
contents, credential values and unbounded messages are not audit metadata.

## Scoped Runtime Evidence

New project only: `codelens_phase3f_static_20261004`.
API: `http://localhost:55407/api/v1`; web: `http://localhost:53407`.
New PostgreSQL/Redis and broker-control/journal volumes use that project prefix.
Existing proof/project resources are not reused or modified. Certified immutable
broker/executor images are reused, not their runtime resources or source policy.
No Docker socket is mounted into API/worker. An ignored explicit preload supplies
deterministic Git objects and blocks external Git transport; it is not in images.

Final runtime image identities:

```text
API/worker: sha256:8b2b37300edbae2cca972995b3136033ccc97d13dd65b1c90dd2ccb03a78214c
Web: sha256:32fe0803b7760fe76f0e09e0db0ca1a2143abd0390b5f2cd19c1cbff7fb405f3
Validation broker: sha256:cc4a89f6ed8d52b0b9425d478184c01585fbe75acb285b249537f77ba4d45682
Validation executor: sha256:1612f9e6885a8c78785c09c68b80e8ea34c88036b527f5f76b9a71ae6348e40e
```

Upgrade deploys the certified eight-migration foundation, creates a historical
paired validation, fingerprints every previous application table, then applies
the additive migration. Fingerprints remain identical and both new tables are
initially empty. Fresh `fresh_final` initialization applies all nine migrations
successfully; all 46 application tables are empty before explicit demo/fixture use.

During development the new, not-yet-frozen migration initially had a PL/pgSQL CASE
parenthesization error. Failed isolated metadata was marked rolled back, then the
corrected additive migration was applied without changing old data/migrations.
An initial proof-driver history check also counted an unfinished migration; it
was corrected to require successful finished, non-rolled-back history. Fresh proof
was repeated against a different genuinely empty isolated database (`fresh_final`),
without migrate-resolve. Neither earlier failed attempt is represented as a pass.

Final queued validation `f1632a8f-ed50-4ab8-8207-7a530ad655f1` traverses real API,
Redis/BullMQ, worker and authenticated validation broker: COMPLETED/BOTH_PASS,
four paired profile steps, two COMPLETE static analyses, 7 ORIGINAL / 6 PATCHED
findings. Recorded comparison: UNCHANGED 2, RESOLVED 2, INTRODUCED 1, CHANGED 1,
INCOMPARABLE 4. Paired static duration observed: 154-170 ms including orchestration;
this is not a benchmark or worst-case bound.

| Classification | Controlled evidence                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| UNCHANGED      | `src/value.ts` unique eval moves ORIGINAL line 2 to PATCHED line 3; unchanged-file occurrence also persists.             |
| RESOLVED       | Original line 3 eval is absent at its exact mapped patched line; synthetic credential occurrence also disappears.        |
| INTRODUCED     | PATCHED `src/value.ts` line 6 has a new occurrence at a one-to-one edited location.                                      |
| CHANGED        | ORIGINAL line 4 to PATCHED line 5 retains the same rule at the exact mapped location with different matched content.     |
| INCOMPARABLE   | Two identical multiline eval constructs, ORIGINAL lines 7/10 and PATCHED lines 8/11, remain four ambiguous observations. |

The first queued proof exposed overly broad same-rule ambiguity suppressing a
provable introduction; exact mapped absence was corrected and regression-tested.
That historical run remains immutable. A proof-driver HTTP 400 expectation was
corrected to the API's existing 422 contract; no API error behavior was changed.
Browser assertions were corrected to wait for loaded results, scope a specific
run and inspect the opened occurrence rather than ambiguous repeated text.

API proof covers request replay, complete readback, cursor paging, filters,
anonymous denial, second-tenant scoped 404, forbidden query rejection and historical
absence. Database proof rejects static row updates, checks four safe audits and
unchanged ACCEPTED/APPLIED advisory states. API/worker/web restart with Redis and
database available preserves all runs/attempts/steps/static observations exactly.
This does not prove graceful draining through Redis/dependency loss.

Synthetic credential checks cover static persistence/API/panel and checked isolated
logs/audits. The pre-existing proposal canonical diff intentionally contains original
source, including the synthetic fixture's removed marker; it is not a static finding
or a new source viewer. Whole-workspace source/diff redaction and universal secret
non-leakage are not claimed. Runtime artifacts/screenshots remain ignored.

Fixture exact HEAD/source/snapshot digests remain identical. The transport supplies
immutable objects without a repository worktree/index/refs, and rejects external
calls; no branch, commit, push or GitHub mutation is involved. This is deterministic
transport proof, not another real-GitHub integration smoke test.

## Verification Results and Boundaries

- Prisma validate/generate, migration lifecycle tests and production builds pass.
- Static package: 47 tests (31 occurrence, five worker lifecycle, 11 line anchor).
- Focused validation/API: 50 tests (26 lifecycle, six static result safety,
  16 reconstruction/comparison and two queue tests).
- Database lifecycle: 20 tests, including the additive static migration invariant.
- Full workspace: 691 passed, seven Windows-specific skips; independent Linux
  executor 32/32 and broker 13/13 cover the platform-specific cases.
- Sequential typecheck, final web typecheck, package/API/web builds and isolated
  API/web Docker builds pass. Browser evidence has eight grouped checks, including
  truthful wording/filtering, focus, reload, historical absence and 390px layout.
- No newly failing formatting files; existing formatting/Ruff debt is not repaired.
- All eight prior migrations and migration lock are byte-identical. Baseline SHA-256:
  `e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.

Regex/entropy coverage is limited; no AST identity, taint analysis, cross-function
reasoning, dependency reassessment or causal/security verdict is established.
Ambiguous mappings and secret identities remain conservative. Cleanup uncertainty
still blocks relaunch; tests remain untrusted; no exactly-once or universal crash
recovery claim is made. Local Docker containment is not hostile multi-tenant
production certification. Known walkthrough risk drift, expected sign-in diagnostics,
clipping observations and prior formatting/Ruff debt remain untouched.

No provider request, GitHub mutation, ML reassessment, RAG candidate indexing or AI
re-review occurred. Phase 3C deterministic verification remains PASSED; real Gemini
investigation/tool/evidence PARTIALLY VERIFIED; final grounded response/citations
and multi-turn NOT VERIFIED. Phase 3D real-provider PROPOSE_PATCH remains NOT VERIFIED.
Exact-SHA hosted CI for this uncommitted static slice has not run.

## Proposed Commit Inventory

27 files; temporary proof drivers/config/keys/logs/screenshots are excluded.

```text
apps/api/src/collaboration/validation-static-content.test.ts
apps/api/src/collaboration/validation-static-content.ts
apps/api/src/collaboration/validation.controller.ts
apps/api/src/collaboration/validation.service.test.ts
apps/api/src/collaboration/validation.service.ts
apps/web/src/components/workspace/validation-panel.tsx
apps/web/src/components/workspace/validation-static-panel.tsx
apps/web/src/lib/api.ts
apps/web/test/validation-static.mjs
docs/static-validation.md
docs/verification.md
packages/database/package.json
packages/database/prisma/migrations/20261004010000_validation_static_findings/migration.sql
packages/database/prisma/schema.prisma
packages/database/src/client.ts
packages/database/test/validation-static-migration.test.ts
packages/shared/src/contracts/index.ts
packages/shared/src/contracts/validation-static.ts
packages/static-analysis/src/analyzers/pattern-scan.ts
packages/static-analysis/src/analyzers/secret-scan.ts
packages/static-analysis/src/fingerprint.ts
packages/static-analysis/src/sandbox.ts
packages/static-analysis/src/validation-static-runner.test.ts
packages/static-analysis/src/validation-static-runner.ts
packages/static-analysis/src/validation-static-worker.ts
packages/static-analysis/src/validation-static.test.ts
packages/static-analysis/src/validation-static.ts
```

Proposed message:
`feat(validation): persist bounded static occurrence comparisons`.
