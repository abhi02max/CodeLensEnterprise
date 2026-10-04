import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, symlink, link, chmod, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCompatibility, validateInput, LIMITS } from './contracts';
import { collectReport } from './collect';
import { prepareSource } from './prepare';
const input = (path = 'src/a.ts') => ({
  version: 1,
  profile: 'typescript-typecheck-v1',
  files: [
    { path: 'package.json', content: '{}' },
    { path, content: 'export const a = 1;' },
  ],
});
describe('sealed input boundaries', () => {
  it.each([
    '../a',
    '/a',
    'C:/a',
    '\\server\\a',
    '%2e%2e/a',
    'a\0b',
    '.git/config',
    '.husky/pre-commit',
    'hooks/run',
    'node_modules/x',
    'a/../b',
    'NUL.txt',
    'a./b',
  ])('rejects %s', (path) => expect(() => validateInput(input(path))).toThrow());
  it('rejects arbitrary launch fields and object metadata', () => {
    expect(() => validateInput({ ...input(), command: 'sh' })).toThrow();
    expect(() =>
      validateInput({ ...input(), files: [{ path: 'x', content: '', type: 'symlink' }] }),
    ).toThrow();
  });
  it('rejects duplicate paths, parent files, and component case collision', () => {
    for (const paths of [
      ['a', 'a'],
      ['a', 'a/b'],
      ['A/a', 'a/b'],
    ])
      expect(() =>
        validateInput({ ...input(), files: paths.map((path) => ({ path, content: '' })) }),
      ).toThrow();
  });
  it('rejects byte bounds and binary/invalid Unicode', () => {
    for (const content of ['\0', '\ud800', 'a'.repeat(LIMITS.fileBytes + 1)])
      expect(() => validateInput({ ...input(), files: [{ path: 'a', content }] })).toThrow();
  });
  it('has stable byte identity independent of file order', () => {
    const original = input();
    expect(validateInput(original).digest).toBe(
      validateInput({ ...original, files: [...original.files].reverse() }).digest,
    );
  });
  it.each([
    'pnpm-lock.yaml',
    'package-lock.json',
    'vitest.config.js',
    'vitest.workspace.ts',
    'tsconfig.json',
    '.npmrc',
    'sub/package.json',
  ])('unsupported closure/configuration: %s', (path) => {
    expect(() => checkCompatibility(validateInput(input(path)).input)).toThrow('UNSUPPORTED');
  });
  it('rejects test annotations that switch environment/pool', () => {
    const value = input();
    value.files[1]!.content = '// @vitest-environment ./evil.js';
    expect(() => checkCompatibility(validateInput(value).input)).toThrow('UNSUPPORTED');
  });
  it('rejects unapproved dependencies and workspace metadata, but never runs scripts', () => {
    for (const pkg of [
      { dependencies: { x: '1' } },
      { workspaces: ['x'] },
      { devDependencies: { vitest: '^2.1.8' } },
    ]) {
      const value = input();
      value.files[0]!.content = JSON.stringify(pkg);
      expect(() => checkCompatibility(validateInput(value).input)).toThrow();
    }
    const value = input();
    value.files[0]!.content = JSON.stringify({ scripts: { test: 'curl evil' } });
    expect(() => checkCompatibility(validateInput(value).input)).not.toThrow();
  });
});
describe.skipIf(process.platform === 'win32')(
  'exclusive source and hostile report filesystem',
  () => {
    const roots: string[] = [];
    const dir = async () => {
      const root = await mkdtemp(join(tmpdir(), 'validation-test-'));
      roots.push(root);
      return root;
    };
    afterEach(async () => {
      // Restore only fixture directory permissions; never follow generated symlinks.
      const restoreDirectories = async (path: string): Promise<void> => {
        const st = await lstat(path);
        if (!st.isDirectory() || st.isSymbolicLink()) return;
        await chmod(path, 0o700);
        for (const entry of await readdir(path)) await restoreDirectories(join(path, entry));
      };
      for (const root of roots.splice(0)) {
        await restoreDirectories(root);
        await rm(root, { recursive: true, force: true });
      }
    });
    const report = JSON.stringify({ version: 1, kind: 'tests', passed: 1, failed: 0, total: 1 });
    it('prepares source only once', async () => {
      const root = await dir();
      await prepareSource(input(), root);
      expect((await lstat(root)).mode & 0o777).toBe(0o555);
      expect((await lstat(join(root, 'src'))).mode & 0o777).toBe(0o555);
      expect((await lstat(join(root, 'package.json'))).mode & 0o777).toBe(0o444);
      await expect(prepareSource(input(), root)).rejects.toThrow();
    });
    it('accepts only a bounded regular report', async () => {
      const root = await dir();
      await writeFile(join(root, 'report.json'), report);
      expect((await collectReport(root)).passed).toBe(1);
    });
    it('rejects generated symlinks and hardlinks', async () => {
      for (const kind of ['symlink', 'hardlink']) {
        const root = await dir(),
          other = await dir();
        await writeFile(join(other, 'target'), report);
        await (kind === 'symlink' ? symlink : link)(
          join(other, 'target'),
          join(root, 'report.json'),
        );
        await expect(collectReport(root)).rejects.toThrow();
      }
    });
    it('rejects malformed, oversized and unexpected output', async () => {
      for (const value of ['bad', 'x'.repeat(LIMITS.reportBytes + 1)]) {
        const root = await dir();
        await writeFile(join(root, 'report.json'), value);
        await expect(collectReport(root)).rejects.toThrow();
      }
      const root = await dir();
      await writeFile(join(root, 'unexpected'), '');
      await expect(collectReport(root)).rejects.toThrow();
    });
  },
);
