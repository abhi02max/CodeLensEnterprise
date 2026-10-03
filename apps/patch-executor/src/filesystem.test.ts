import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fs = vi.hoisted(() => ({ lstat: vi.fn(), mkdir: vi.fn(), open: vi.fn(), readdir: vi.fn() }));
vi.mock('node:fs/promises', () => fs);
vi.mock('@codelens/patch-core', () => ({
  patchHash: (value: string) => createHash('sha256').update(value).digest('hex'),
  materializeCandidate: () => ({
    originals: [
      {
        path: 'src/a.ts',
        content: 'old',
        byteLength: 3,
        contentHash: createHash('sha256').update('old').digest('hex'),
      },
    ],
    candidates: [],
    result: { verified: true },
  }),
}));
import { executeMaterialization } from './materialize';
const descriptors = new Map(
  ['platform', 'getuid', 'getgid'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(process, key),
  ]),
);
function directory() {
  return { isDirectory: () => true, isSymbolicLink: () => false, uid: 65532 };
}
function file() {
  return { isFile: () => true, uid: 65532, nlink: 1, mode: 0o600 };
}
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  Object.defineProperty(process, 'getuid', { value: () => 65532, configurable: true });
  Object.defineProperty(process, 'getgid', { value: () => 65532, configurable: true });
  vi.spyOn(process, 'umask').mockReturnValue(0o077);
  fs.readdir.mockResolvedValue([]);
  fs.lstat.mockImplementation(async (path: string) =>
    path.endsWith('a.ts') ? file() : directory(),
  );
  fs.open.mockResolvedValue({
    writeFile: vi.fn(),
    close: vi.fn(),
    readFile: vi.fn(async () => Buffer.from('old')),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(process, key, descriptor);
    else Reflect.deleteProperty(process, key);
  }
});
it('requires a new empty owned workspace', async () => {
  fs.readdir.mockResolvedValue(['preexisting']);
  await expect(executeMaterialization({}, '/workspace')).rejects.toThrow('PRECONDITION');
  expect(fs.open).not.toHaveBeenCalled();
});
it.each(['symlink', 'foreign-owner', 'not-directory'])(
  'rejects %s parent before opening any file',
  async (kind) => {
    fs.lstat.mockImplementation(async (path: string) =>
      path === '/workspace'
        ? directory()
        : {
            isDirectory: () => kind !== 'not-directory',
            isSymbolicLink: () => kind === 'symlink',
            uid: kind === 'foreign-owner' ? 0 : 65532,
          },
    );
    await expect(executeMaterialization({}, '/workspace')).rejects.toThrow('PRECONDITION');
    expect(fs.open).not.toHaveBeenCalled();
  },
);
it.each(['symlink', 'hardlink', 'special', 'executable'])(
  'rejects %s file after exclusive creation',
  async (kind) => {
    fs.lstat.mockImplementation(async (path: string) =>
      path.endsWith('a.ts')
        ? {
            ...file(),
            isFile: () => kind !== 'special' && kind !== 'symlink',
            nlink: kind === 'hardlink' ? 2 : 1,
            mode: kind === 'executable' ? 0o700 : 0o600,
          }
        : directory(),
    );
    await expect(executeMaterialization({}, '/workspace')).rejects.toThrow('PRECONDITION');
    expect(fs.open).toHaveBeenCalledTimes(1);
  },
);
it('independently rereads and rejects original hash mismatch', async () => {
  fs.open.mockResolvedValue({
    writeFile: vi.fn(),
    close: vi.fn(),
    readFile: vi.fn(async () => Buffer.from('bad')),
  });
  await expect(executeMaterialization({}, '/workspace')).rejects.toThrow('PRECONDITION');
});
