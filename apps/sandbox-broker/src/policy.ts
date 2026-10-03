export const BROKER_POLICY = Object.freeze({
  concurrency: 1,
  deadlineMs: 150000,
  cleanupReserveMs: 50000,
  daemonOperationMs: 10000,
  pendingConnections: 4,
  nonceCapacity: 1024,
  authenticationAgeMs: 60000,
});

/** Configuration is broker-owned deployment data, never a request field. */
export function executorPolicy(imageId: string, seccomp: string, labels: Record<string, string>) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('PINNED_IMAGE_REQUIRED');
  const profile = JSON.parse(seccomp);
  if (profile.defaultAction !== 'SCMP_ACT_ERRNO' || !Array.isArray(profile.syscalls))
    throw new Error('SECCOMP_POLICY_REQUIRED');
  return {
    Image: imageId,
    User: '65532:65532',
    Entrypoint: ['/nodejs/bin/node', '/executor.cjs'],
    Cmd: [],
    Env: ['LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'TZ=UTC', 'PATH=', 'SSL_CERT_FILE='],
    WorkingDir: '/workspace',
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    Labels: labels,
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges', 'seccomp=' + seccomp],
      Privileged: false,
      PidMode: '',
      IpcMode: 'private',
      CgroupnsMode: 'private',
      Binds: [],
      Mounts: [],
      Devices: [],
      PortBindings: {},
      ReadonlyPaths: [
        '/proc/bus',
        '/proc/fs',
        '/proc/irq',
        '/proc/sys',
        '/proc/sysrq-trigger',
        '/dev/shm',
        '/dev/mqueue',
      ],
      Tmpfs: { '/workspace': 'rw,noexec,nosuid,nodev,size=67108864,uid=65532,gid=65532,mode=0700' },
      NanoCpus: 500000000,
      Memory: 536870912,
      MemorySwap: 536870912,
      PidsLimit: 64,
      Ulimits: [{ Name: 'nofile', Soft: 256, Hard: 256 }],
      LogConfig: { Type: 'none', Config: {} },
      AutoRemove: false,
    },
  };
}
