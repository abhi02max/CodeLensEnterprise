import { LIMITS, ProfileId } from '@codelens/validation-executor';
import type { z } from 'zod';

export function approvedProfile(
  id: z.infer<typeof ProfileId>,
  image: string,
  bundleDigest: string,
  configurationDigest: string,
) {
  ProfileId.parse(id);
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image) ||
    !/^[a-f0-9]{64}$/.test(bundleDigest) ||
    !/^[a-f0-9]{64}$/.test(configurationDigest)
  )
    throw new Error('DEPLOYMENT_IDENTITY_REQUIRED');
  return Object.freeze({
    id,
    version: 1 as const,
    ecosystem: 'node-single-package',
    image,
    bundleDigest,
    configurationDigest,
    executable: '/nodejs/bin/node',
    args: Object.freeze(['/runner.cjs', id]),
    workingDirectory: '/input',
    timeoutMs: LIMITS.executionMs,
    nanoCpus: 500000000,
    memory: 536870912,
    swap: 536870912,
    pids: 64,
    descriptors: 128,
    fileSize: 8 * 1024 * 1024,
    temporaryBytes: 32 * 1024 * 1024,
    outputBytes: 2 * 1024 * 1024,
    stdoutBytes: LIMITS.streamBytes,
    stderrBytes: LIMITS.streamBytes,
    reportBytes: LIMITS.reportBytes,
    network: 'none',
    resultVersion: 1,
  });
}
export type ApprovedProfile = ReturnType<typeof approvedProfile>;
export const ENVIRONMENT = Object.freeze([
  'LANG=C.UTF-8',
  'LC_ALL=C.UTF-8',
  'TZ=UTC',
  'PATH=/nodejs/bin',
  'HOME=/tmp/home',
  'TMPDIR=/tmp',
  'NODE_ENV=test',
  'SSL_CERT_FILE=',
]);
export function containerPolicy(
  profile: ApprovedProfile,
  seccomp: string,
  labels: Record<string, string>,
  sourceVolume: string,
  prepare = false,
) {
  const parsed = JSON.parse(seccomp) as { defaultAction?: string; syscalls?: unknown[] };
  if (parsed.defaultAction !== 'SCMP_ACT_ERRNO' || !Array.isArray(parsed.syscalls))
    throw new Error('SECCOMP_REQUIRED');
  return {
    Image: profile.image,
    User: prepare ? '0:0' : '65532:65532',
    Entrypoint: ['/nodejs/bin/node', prepare ? '/prepare.cjs' : '/runner.cjs'],
    Cmd: prepare ? [] : [profile.id],
    Env: [...ENVIRONMENT],
    WorkingDir: '/input',
    AttachStdin: prepare,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: prepare,
    StdinOnce: prepare,
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
      Mounts: [
        {
          Type: 'volume',
          Source: sourceVolume,
          Target: '/input',
          ReadOnly: !prepare,
          VolumeOptions: { NoCopy: true },
        },
      ],
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
      Tmpfs: {
        '/tmp': `rw,noexec,nosuid,nodev,size=${profile.temporaryBytes},uid=65532,gid=65532,mode=0700`,
        '/output': `rw,noexec,nosuid,nodev,size=${profile.outputBytes},uid=65532,gid=65532,mode=0700`,
      },
      NanoCpus: profile.nanoCpus,
      Memory: profile.memory,
      MemorySwap: profile.swap,
      PidsLimit: profile.pids,
      Ulimits: [
        { Name: 'nofile', Soft: profile.descriptors, Hard: profile.descriptors },
        { Name: 'fsize', Soft: profile.fileSize, Hard: profile.fileSize },
      ],
      LogConfig: { Type: 'none', Config: {} },
      AutoRemove: false,
    },
  };
}
