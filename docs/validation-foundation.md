# Phase 3F Validation Security Foundation

This foundation checkpoint is an execution boundary, not the validation product.
It did not include a ValidationRun model, migration, API, queue or frontend.
The subsequent [paired-validation product slice](paired-validation.md) is separate;
static reruns, ML reassessment, RAG and AI re-review remain excluded.
Phase 3E remains a separate, non-executing
materializer. Passing validation is not a safety guarantee.

## Supported scope

The two immutable local-proof profiles are `typescript-typecheck-v1` and
`vitest-unit-v1`, version 1, policy `validation-local-v1`. They accept one package
with opaque UTF-8 text files. There is no host path, Git checkout or `.git`.
TypeScript 5.7.3, Vitest 2.1.8 and Node types 22.10.5 are prebuilt from the frozen
workspace lockfile. The image digest binds actual installed bytes; the bundle
identity records the SHA-256 of that lockfile. No package installation occurs
when source is prepared or executed. Image construction is a separate trusted
operator operation and can access registries without repository source.

Declared dependencies must be members of that exact tool closure, without
version ranges. General application dependency closures, lockfiles, nested
packages, workspaces, repository TypeScript/Vite/Vitest configuration and Vitest
environment/pool annotations are UNSUPPORTED. Package scripts are inert data.
Undeclared/dynamic imports can fail execution; they cannot trigger acquisition.
Maven, Gradle, Python, pytest, builds and arbitrary plugins are not supported.

Typecheck uses the image-owned TypeScript API with fixed strict/noEmit options,
not the repository tsconfig. Vitest uses an image-owned programmatic launcher
and configuration with config discovery disabled, Node environment, a single
fork, fixed discovery and no coverage installation. Workspace configuration is
rejected before launch. Repository-controlled tests still execute arbitrary
code inside the container; the fixed launcher is not a command allowlist for
all child processes that such code can attempt.

## Trust boundaries and protocol

`apps/validation-broker` alone receives validation Docker authority. Its separate
Unix socket is `/control/validation.sock`; its separate 32-byte key is read from
`/run/secrets/validation-key`. Neither path is mounted into executors. Requests
use `codelens-validation-v1`, a strict four-byte length-prefixed JSON frame,
profile identity, bounded source files, UUID nonce, authenticated timestamps and
HMAC-SHA-256. Responses use a different authenticated protocol domain and bind
the nonce, input digest, image, bundle and configuration identities.

Authentication accepts a bounded clock skew, expires requests and clamps the
operation deadline to the connection's server-owned budget. Durable exclusive
nonce files with file/directory fsync reject replay across broker restart.
Single-process consumption serializes expiration/capacity checks. Only one
backend operation runs at a time; at most four connections are admitted.
Invalid requests, authentication, replay and busy failures close the connection
without echoing request bodies or credentials.

The result explicitly separates **broker-observed** start, exit, timeout, OOM,
policy identity, duration and cleanup from **runner-reported** bounded counts.
Runner reports always have `trusted: false`: malicious tests can forge reports,
exit deliberately or print the report marker. Broker signing authenticates
observation origin, not test truth. Duplicate/malformed/wrong-kind reports are
rejected; missing reports remain missing. Exit with failing tests is
VALIDATION_EXECUTED, not infrastructure failure.

## Source, filesystem and collection

The broker creates a fresh labeled input volume. A credential-free, non-executing
preparer runs as UID 0 with capabilities dropped, a read-only root and no network;
it creates only bounded regular files using exclusive/no-follow opens, verifies
owner/link count, and seals files/directories. The preparer receives no key or
Docker socket. Its digest must match independently normalized broker input.
Source is then mounted read-only into a NEW UID/GID 65532 execution container.
The root preparer is distinct from the non-root hostile-code executor.

Limits: 1,000 files, 1 MiB/file, 16 MiB aggregate source, 24 MiB framed input,
240-byte paths and depth 16. Absolute/Windows/UNC/encoded/traversal paths, NUL,
invalid Unicode, duplicate/file-parent/case-colliding paths and object metadata
are rejected. Symlinks, hardlinks and special input objects have no protocol
representation. No host source bind, persistent workspace or writable shared
dependency cache is available.

Only `/output/report.json` is collected. The collector rejects unexpected output
entries, no-follow open failures, non-regular files, wrong owners, multiple links,
oversize files and observed changes during reads. It reads at most 64 KiB plus
one overflow byte and never extracts archives or recursively collects generated
files. This collector shares the hostile execution boundary: its exported
counts remain runner-reported, never authoritative facts.

## Resource and network policy

Executors use an exact SHA-256 image identity, read-only root, UID/GID 65532,
cap-drop ALL, no-new-privileges, an independent default-deny x86-64 seccomp
policy, private PID/IPC/cgroup namespaces and network none. The policy permits
ordinary child creation but denies namespace creation and privileged operations.
It does not weaken Phase 3E's seccomp policy.

Each executor has 0.5 CPU quota, 512 MiB memory, no additional swap, 64 PIDs,
128 descriptors, an 8 MiB individual-file limit, a 32 MiB private `/tmp`, and a
2 MiB `/output` tmpfs. Tmpfs mounts are noexec/nosuid/nodev; noexec does not stop
Node from evaluating JavaScript. Execution budget is 30 seconds; total operation
budget is 120 seconds with 30 seconds reserved for cleanup. Daemon calls are
bounded by their applicable remaining deadline and a 10-second maximum.

The explicit executor environment is LANG, LC_ALL, TZ, PATH, HOME, TMPDIR,
NODE_ENV and an empty SSL_CERT_FILE. Image defaults are overridden; no host
environment or DB/Redis/GitHub/OAuth/JWT/encryption/provider/cloud/broker key is
forwarded. Installed dependencies and trusted policy files remain read-only.

Network none removes external routes, not private loopback. Local loopback
servers are allowed by this profile. Connection probes exercise Internet,
GitHub, registry, metadata, host gateway and API/DB/Redis/ML/Docker destination
ports; they are transport-denial probes, not protocol-level service tests.
No repository dependency acquisition, external model call or GitHub request is
part of foundation execution.

Stdout and stderr each have a hard 1 MiB capture bound. Exceeding a bound stops
the entire owned container, not just a direct child. A partial capture is marked
incomplete; its digest is the captured prefix digest, not a claimed full-stream
digest. Excerpts are byte-bounded to 8 KiB, strip ANSI/OSC/control/bidi sequences,
and use existing diagnostic redaction. Logs are disabled at the Docker driver.
No full source or test names/messages are exported as dedicated structured
artifacts. Bounded excerpts can contain repository-generated text; redaction is
not a universal secret-detection guarantee.

## Cancellation, ownership and recovery

Disconnecting the authenticated caller cancels its operation. SIGTERM aborts
active broker operations. Late operations are fenced before start/finalization;
the entire owned container is killed/deleted and absence is verified before its
input volume is removed. No successful result is returned after cancellation.

Durable HMAC-authenticated ownership journals precede create calls and bind names,
image identities and acknowledged container IDs. Cleanup verifies daemon labels
and identities before deletion. Foreign resources are never deleted. A lost
create acknowledgment with no observed resource is not proof of absence: it
leaves UNCERTAIN cleanup and blocks further execution. Restart reconciles only
authenticated owned records. Corrupted/partial journals fail closed and require
operator investigation; there is no unsafe reset/override. This is not an
exactly-once or universal crash-recovery guarantee, nor secure disk erasure.

## Local backend and production boundary

`ValidationBackend` is the narrow profile/input/observation interface. Only
DockerValidationBackend is implemented. Startup requires explicit
`docker-local-proof` and local-proof acknowledgement. An unimplemented stronger
backend is rejected, never downgraded.

Docker Desktop proof covers the tested local container mechanisms only. It does
NOT certify hostile multi-tenant production safety, truthful tests, kernel escape
prevention, supply-chain security, broker compromise prevention or patch safety.
Before hostile multi-tenant production enablement require a dedicated validation
host plus reviewed gVisor or VM-backed isolation, new backend-specific adversarial
proof and operational recovery review. No stronger backend has been tested here.

## Operator verification

Run workspace tests, sequential typecheck and production builds. Both Dockerfiles
run Linux foundation tests in their build stages, including filesystem and nonce
tests skipped on Windows. Build the executor with BUNDLE_DIGEST equal to the
SHA-256 of pnpm-lock.yaml, and CONFIGURATION_DIGEST equal to SHA-256 of the
concatenated UTF-8 contents of vitest.config.mjs, vitest-runner.mjs and executor
src/main.ts. Inspect the resulting image ID; use that exact identity in Compose.

`apps/validation-broker/test/runtime.cjs` is an operator-only proof driver excluded
from production image contexts. Invoke it with the local Docker executable path.
It uses only `codelens_phase3f_foundation_20261004`, separate control/journal
volumes and a newly generated local key. It exercises normal pass/fail, actual
policy inspection, hostile filesystem/output/process/memory fixtures, cancellation,
restart, compatibility failure and preservation of existing container identities.
Local key and generated proof reports stay under ignored `.codelens-tmp`.

Final runtime evidence must come from the final rebuilt images, not an earlier
debugging build. Existing migrations, migration lock, Phase 3E implementation,
known walkthrough drift and unrelated formatting/Ruff debt remain untouched.

## Checkpoint evidence: 2026-10-04

Local Docker foundation proof: **PASSED**, 23 scenarios through the real
authenticated broker/preparer/executor path. Normal typecheck/tests distinguish
pass and failure. Generated symlink/hardlink, malformed, oversized and unexpected
reports are rejected. Both direct-descriptor floods terminate with OUTPUT_LIMIT;
the infinite loop terminates with TIMEOUT; memory pressure records OOM; process
storm, detached-child lifetime and active cancellation remain contained. Source
volumes and both preparer/executor containers are absent after every scenario.
Private loopback succeeds; the listed external connection probes fail. Actual
container inspection verifies the environment and fixed isolation/resource policy.
Restart and UNSUPPORTED/no-launch behavior pass. Existing non-foundation
container identities remain unchanged.

Final executor image:
`sha256:1612f9e6885a8c78785c09c68b80e8ea34c88036b527f5f76b9a71ae6348e40e`.
Final broker image:
`sha256:cc4a89f6ed8d52b0b9425d478184c01585fbe75acb285b249537f77ba4d45682`.
These are local tested image identities, not published registry releases.

Workspace tests: 599 passed, seven Linux-specific tests skipped on Windows.
Linux image-build foundation tests: executor 32/32 and broker 9/9 passed,
including 64 concurrent durable nonce consumers with one success, restart replay
rejection, and ownership/cleanup-uncertainty fencing. Sequential workspace
typecheck, production package/API/web builds, both images, scoped formatting and
git diff --check pass. All seven migrations and the migration lock were compared
byte-for-byte with starting HEAD; no migration or product layer was added.

Pre-final proof exposed bundling/framed-socket/config-loading issues, which were
corrected and reverified. One pre-final restart deliberately failed closed when
a concurrent image retag removed its pinned old image. Final evidence comes from
frozen retained image identities with no rebuild during the run. Output-flood
fixtures handle nonblocking pipe backpressure rather than mistaking EAGAIN or
Vitest console interception for broker byte-limit enforcement. Detached-child
proof ends through the fixed test timeout/container exit, not an invented broker
wall-clock timeout.

This does not prove hostile multi-tenant production safety, a stronger backend,
universal containment/secret detection, truthful tests, exactly-once execution,
or safety of a proposed patch. No real provider call, GitHub mutation, product
validation, static/ML/RAG rerun or AI re-review occurred. Source remains uncommitted
pending review of this checkpoint.
