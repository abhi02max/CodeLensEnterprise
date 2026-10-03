# Phase 3E foundation: exact snapshots and restricted materialization

## Scope and status

Starting revision: `9dfb7c418cbc1822f1bce9cb0c1532cd921026a6`.
Foundation deterministic implementation and isolated runtime verification: PASSED.
This is a security prerequisite, not the PatchApplication feature. No new database
model, migration, application API, queue, frontend action, or Phase 3F validation
exists. No repository checkout or proposed-code execution occurs.

Architecture: credential-bearing orchestration code reads exact Git objects,
then a local authenticated channel sends data to a fixed-policy broker. Only the
broker has Docker authority. Its credential-free executor writes opaque candidate
text into a new ephemeral tmpfs, verifies bytes, returns hashes, and exits.
The normal API/worker and existing Compose stack receive no Docker authority.
`AnalysisSandbox` is not used as an isolation boundary.

## Exact snapshot and canonical core

The transport reads an exact commit and nonrecursive trees/blobs. It never clones,
checks out, extracts an archive, reads the developer repository as source, or
mutates GitHub. Every file passes the existing exact-Git verifier; immutable reads
are cached only within that operation. Cancellation fences even a reader that
ignores its AbortSignal. The returned snapshot, file array, and file records are
frozen. Lowercase 40-character exact SHAs are required by this snapshot protocol.

The entire repository snapshot must be mode `100644`, regular, valid UTF-8 text
without NUL bytes. Unsupported/binary/executable/symlink/gitlink objects, unsafe
paths, truncated/inconsistent trees, case collisions, and limit excess reject the
whole operation. Nothing is silently omitted. Empty exact trees are supported.
Path components additionally cannot exceed 255 UTF-8 bytes, matching the target
filesystem restriction. The common verifier retains its prior path/object rules.

Bounds: 1,000 files; 2,000 visited tree entries; depth 16; individual source blob
1 MiB; decoded source 16 MiB; candidate 20 MiB; framed input 24 MiB; framed output
256 KiB. Existing 3D proposal limits remain 10 modified files, 500 changed lines,
64 KiB canonical proposal. Bounds reject, never truncate.

Snapshot SHA-256 binds UTF-8 `JSON.stringify` of this ordered object:
`{version, repository, revision, files: [{path, blobSha, contentHash, byteLength}]}`.
Files use ascending JavaScript string comparison, not locale sorting. Source
SHA-256 and Git blob SHA-1 bind verified bytes; the source text itself is not in
the manifest. Empty directories are validated during traversal but are not
materialized as source files. The exact commit SHA binds the complete Git tree.

`@codelens/patch-core` extracts the existing 3D normalization, exact ranges/text,
disjoint MODIFY edits, canonical diff, and proposal digest algorithm. The API
retains a thin error-translation wrapper, not a competing edit algorithm. The
executor independently checks sorted paths, all source hashes/byte lengths/blob
identities, snapshot digest, pinned head, expected text/blob, proposal digest,
and candidate limits. No fuzzy matching or model-authoritative diff is used.

Result SHA-256 binds ordered JSON:
`{version, snapshotDigest, proposalDigest, files: [{path, contentHash, byteLength}]}`.
Only this bounded manifest is returned, never candidate source or diff output.
Authorization, ACCEPTED-state revalidation, evidence ownership, durable attempt
identity, and stale-head fences belong to the future application domain. These
primitives do not purport to implement them.

## Executor and broker boundary

Both final runtime images use pinned distroless Node 22 Debian 12:
`sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e`.
The executor copies only its bundled fixed entrypoint. Image inventory listing
(no archive extraction) checked 1,792 paths: Node and executor present, zero
checked shell/Git/package-manager/curl/wget/Docker-tool paths. Build-time compilers
and dependencies are not copied into the final runtime filesystem.

Executor UID/GID is 65532:65532. No process launcher, network transport, plugin
loader, eval, or user-controlled executable is implemented. Source/replacement
text remains opaque. Node itself still contains built-in modules; this is not a
claim that the runtime binary lacks all networking or execution capabilities.

The broker is an explicitly privileged trusted computing base because Docker
daemon access is host-equivalent authority. It must be deployed separately with
reviewed configuration and one instance per namespace. Image approval is an
operator review/pin boundary, not signed-image attestation. Deployment selects an
exact local Docker image SHA-256; request data cannot select an image or policy.
The broker has only one public operation over `/control/broker.sock`, not generic
Docker RPC. The HTTP Docker transport is internal and uses the Unix daemon socket.

Worker/client request: strict version-1 schema, UUID nonce, issued/deadline times,
payload, HMAC-SHA256 using a dedicated 32-byte secret. The authenticated lifetime
is 60 seconds, with at most 1,024 remembered nonces. Nonce consumption is recorded
with exclusive private writes and flushed before launch; durable restart replay
behavior is tested. Responses are strict, HMAC-authenticated, and nonce-bound.
Four pending connections maximum; one global launch per broker process; busy or
uncertain cleanup rejects rather than creating unbounded executors. A separate
multi-instance broker coordination design is not implemented.

One big-endian 32-bit length-prefixed UTF-8 JSON frame is terminated by EOF.
Invalid/trailing/incomplete frames reject. Allocation is bounded by the validated
header, rather than retaining arbitrary numbers of fragments. Source is never in
command-line arguments. No broker auth material enters the executor frame.

The worker adapter shares one 150-second absolute budget across exact snapshot
and broker work. The broker reserves 50 seconds for bounded daemon settlement and
cleanup, leaving at most 100 seconds for materialization after snapshot/channel
time. Requests with no cleanup reserve reject before creation. Individual daemon
calls have 10-second absolute/inactivity limits. Timeouts cannot prove remote
operations never settled, and scheduler/filesystem/daemon failures are not a
real-time guarantee. Cleanup uncertainty is explicit, never reported as success.

Fixed executor policy:

- exact pinned image, `/nodejs/bin/node /executor.cjs`, no caller command;
- network none, private/default PID, private IPC/cgroup namespace, no ports;
- read-only root, no binds/devices/host source/socket mounts;
- drop ALL capabilities, no-new-privileges, reviewed x86_64 seccomp allowlist;
- `/workspace`: 64 MiB tmpfs, mode 0700, UID/GID 65532, noexec/nosuid/nodev;
- Docker-created `/dev/shm` and `/dev/mqueue` remounted read-only;
- 0.5 CPU, 512 MiB memory, swap equal to memory, 64 PIDs, 256 descriptors;
- allowlisted LANG/LC_ALL/TZ; empty PATH/SSL_CERT_FILE overrides inherited image
  defaults; no application environment inheritance; Docker logging disabled.

Filesystem writes require a fresh empty owned directory. Paths/case collisions
are checked independently; parents are checked for regular directories/ownership;
files use exclusive creation and O_NOFOLLOW, mode 0600, regular-file/link-count/
owner/no-executable checks, and raw-byte hash/length readback before and after
replacement. No archives, hardlinks, hooks, or `.git` are created. Private single-
process workspace ownership is part of the race-prevention assumption; this is
not a general hostile shared-filesystem API.

The seccomp profile allows required Node thread/I/O startup operations and initial
execve. It denies default syscalls, process-style clone/namespace flags and other
unlisted operations; clone3 returns ENOSYS for the filtered clone fallback. It is
not a proof against a compromised Node runtime or Linux kernel. Other CPU
architectures have not been validated.

## Cleanup and retention

Ownership is recorded before creation; labels plus a secret-derived ownership
proof, exact recorded image and acknowledged container identity fence removal.
Late create/attach/start settlement is awaited before owned cleanup. Success
requires removal and confirmed absence; tmpfs workspace then disappears.
Only bounded hashes/manifests and ownership/nonce metadata need retention.
No durable candidate filesystem is exposed. No broad Docker prune/list-and-delete
or cleanup of foreign containers exists.

If create acknowledgement is lost, immediate absence does not establish cleanup:
the reservation remains and further launches fail closed. Startup reconciliation
removes only provably owned objects, including prior pinned image generations.
An unresolved absent reservation needs operator investigation; it is not silently
discarded. Cleanup failure, daemon outage, and hostile journal identity are tested.
There is no secure-erasure, exactly-once processing, SIGKILL recovery, universal
race elimination, or deadline-overrun recovery claim.

## Isolated runtime evidence

Project: `codelens_phase3e_foundation_20261003`, with new control/journal/PostgreSQL
volumes and no host ports. Existing CodeLens/previous-phase resources were not
changed. The target API/PostgreSQL/Redis are new isolated control targets, not the
original working services. Runtime proof clients/probes/local secrets are ignored.

Final executor image:
`sha256:5c3608390c5c8b11dcb35b5959c86f76aaa28de893bb7e8eb906486215054fd9`.
Final broker image:
`sha256:2774783653b2ad554a9e27a33a7e8921bb3c66f9675d7655d702e38da60ebf01`.
Read-only observation captured the actual broker-created executor and inspected
its exact image, entrypoint, UID/GID configuration, no mounts/ports, explicit
five-entry environment, security options, tmpfs and resource limits.

A separate test-only probe used the identical executor policy. Runtime facts:
UID/GID 65532; CapEff zero; NoNewPrivs 1; Seccomp 2; CPU cgroup `50000 100000`;
memory.max 536870912; memory.swap.max 0; pids.max 64; descriptor soft/hard 256.
Workspace mount showed noexec/nosuid/nodev and size 65536k; private file mode 0600,
nlink 1. Root, /tmp, /dev/shm and /dev/mqueue writes were denied. Checked host,
socket, control, journal, secret and tool paths were absent.

TCP attempts to Internet `1.1.1.1:443`, GitHub `140.82.112.3:443`, metadata
`169.254.169.254:80`, Docker host-gateway address `192.168.65.254:443`, isolated API
`172.31.250.2:4000`, PostgreSQL `.3:5432`, Redis `.4:6379`, and host daemon TCP
`192.168.65.254:2375` all returned ENETUNREACH. Independent control connections
confirmed the isolated API/PostgreSQL/Redis were listening. The Docker socket was
absent. Host gateway DNS alias resolution was not proven; the address-based denial
is scoped evidence. Private loopback and allowed socket syscalls still exist.

Synthetic read-only Git fixture passed through the real foundation worker adapter,
broker and final executor. Expected and independently reread candidate hash matched:
`fcaa431a8d11af80aa115c2adbba10604156e2cd9bc1b29be3d3cd5ec375aaa5` (14 bytes).
Manifest digest was deterministic across repeated runs/restart:
`3635245593c7a3381e7588ccf1c5fce308217b38493ceff60919ba2f077d56f4`.
Wrong HMAC, expired request, unknown image override and replay were rejected.
A separate delay image exercised a shortened budget: BROKER_DEADLINE, owned
container removal, no residual executor or ownership record. The production image
was restored and successful materialization reconfirmed. Probe container removed.

Final runtime-window source/HEAD/index/refs fingerprints were unchanged. A prior
fingerprint window spanning manual test/formatting edits correctly reported source
change; it was not accepted as non-mutation proof. The final proof window excluded
edits and passed. No source repository/index/refs were used as candidate workspace.
No provider call or GitHub request/mutation occurred in this foundation proof.

## Regression, adversarial review, and limitations

Workspace tests: 505 passed (shared 1, AI 82, database 17, GitHub 81, static 11,
RAG 29, API 240, core 23, executor 10, broker 11). Includes 24 new snapshot tests,
23 core tests, 10 executor tests, 11 broker tests, and preserved 58 API proposal/
construction tests. Prisma validate/generate, sequential typecheck, package/API/
web builds, dedicated app builds and both image builds passed. `git diff --check`
passed. Existing formatting/Ruff debt and walkthrough risk drift were not fixed.

Adversarial corrections: preserved half-closed protocol sockets; normalized HMAC
serialization; rejected unexpected response fields; bounded frame allocation;
independent transport cancellation; immutable snapshots; raw-byte reread hashes;
waited for exit before accepting results; fenced late daemon settlement; treated
unacknowledged creation as uncertain; shared deadlines/cleanup reserve; blocked
Docker's incidental writable shm/mqueue; retained only safe failure categories.
The response-bound regression reaches its bound with valid source/proposal
digests rather than failing an unrelated precondition.

This is sufficient foundation evidence for review before designing application
authorization/persistence/integration. It does not authorize starting that work.
No production deployment/hosted CI for this uncommitted revision is claimed.
Maximum-bound performance, OOM/PID/CPU saturation, malicious daemon/kernel attacks,
power-loss durability, multi-broker HA, all filesystem races, universal secret
non-leakage, and semantic proposal quality are not proven. Repository source itself
may contain secrets; absence of inherited executor credentials is a different
claim. Future deployment must keep the key/control/journal private and pin the
reviewed image. All six existing migrations and migration_lock are byte-identical.
`0_baseline` SHA-256 remains
`e3ea352f1566612be1d402caa215382002e2b2fe299f4818acaf4fc3d2bbe8ab`.

Phase 3C deterministic verification: PASSED; real Gemini investigation/tool/
evidence: PARTIALLY VERIFIED; final grounded response/citations: NOT VERIFIED;
real-provider multi-turn: NOT VERIFIED. Phase 3D deterministic verification:
PASSED; real-provider PROPOSE_PATCH: NOT VERIFIED. PatchApplication and applied-code
validation remain NOT IMPLEMENTED; restricted ephemeral materialization is the
foundation primitive only.

## Exact proposed file inventory (41 files)

```text
.dockerignore
apps/api/package.json
apps/api/src/collaboration/patch-content.ts
apps/patch-executor/Dockerfile
apps/patch-executor/package.json
apps/patch-executor/src/filesystem.test.ts
apps/patch-executor/src/main.ts
apps/patch-executor/src/materialize.test.ts
apps/patch-executor/src/materialize.ts
apps/patch-executor/tsconfig.json
apps/sandbox-broker/Dockerfile
apps/sandbox-broker/package.json
apps/sandbox-broker/src/client.ts
apps/sandbox-broker/src/docker.ts
apps/sandbox-broker/src/launcher.test.ts
apps/sandbox-broker/src/launcher.ts
apps/sandbox-broker/src/main.ts
apps/sandbox-broker/src/nonce-store.test.ts
apps/sandbox-broker/src/nonce-store.ts
apps/sandbox-broker/src/policy.test.ts
apps/sandbox-broker/src/policy.ts
apps/sandbox-broker/src/protocol.ts
apps/sandbox-broker/src/worker-client.ts
apps/sandbox-broker/tsconfig.json
docs/phase3e-foundation.md
docs/verification.md
infra/sandbox/seccomp.json
packages/github/src/client.ts
packages/github/src/exact-git-file.ts
packages/github/src/exact-git-snapshot.test.ts
packages/github/src/exact-git-snapshot.ts
packages/github/src/index.ts
packages/patch-core/package.json
packages/patch-core/src/frame.ts
packages/patch-core/src/index.ts
packages/patch-core/src/materialization.test.ts
packages/patch-core/src/materialization.ts
packages/patch-core/src/patch.ts
packages/patch-core/tsconfig.json
pnpm-lock.yaml
pnpm-workspace.yaml
```

Not proposed: `.compose.phase3e-foundation.local.yml` and everything under
`.codelens-tmp/phase3e-foundation/` (keys/env, clients/watchers/probes/delay images'
drivers/Dockerfiles, bundles, JSON reports, image inventory archives/fingerprints).
Existing ignored artifacts remain ignored. Final images copy only bundled fixed
production entrypoints; test files/drivers are not imported into them. No
credentials or generated runtime evidence files belong in the commit.

Proposed commit: `feat(sandbox): add exact snapshots and restricted patch materialization`.
