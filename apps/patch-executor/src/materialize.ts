import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { materializeCandidate } from '@codelens/patch-core';

const reject = (): never => {
  throw new Error('EXECUTOR_PRECONDITION_FAILED');
};
async function regular(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o111 || stat.uid !== process.getuid!())
    reject();
}
// This module has no process launcher or network transport. Source is opaque data.
export async function executeMaterialization(raw: unknown, workspace: string) {
  if (process.platform !== 'linux' || process.getuid?.() !== 65532 || process.getgid?.() !== 65532)
    reject();
  const stat = await lstat(workspace);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== 65532 ||
    (await readdir(workspace)).length
  )
    reject();
  const candidate = materializeCandidate(raw);
  process.umask(0o077);
  for (const file of candidate.originals) {
    const parts = file.path.split('/');
    for (let n = 1; n < parts.length; n++) {
      const directory = join(workspace, ...parts.slice(0, n));
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 65532) reject();
    }
    const path = join(workspace, file.path);
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(file.content, 'utf8');
    } finally {
      await handle.close();
    }
    await regular(path);
    const verify = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await verify.readFile();
      if (
        bytes.length !== file.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== file.contentHash
      )
        reject();
    } finally {
      await verify.close();
    }
  }
  for (const file of candidate.candidates) {
    const path = join(workspace, file.path);
    await regular(path);
    const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 65532) reject();
      await handle.truncate(0);
      await handle.writeFile(file.content, 'utf8');
    } finally {
      await handle.close();
    }
    await regular(path);
    const verify = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await verify.readFile();
      if (
        bytes.length !== file.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== file.contentHash
      )
        reject();
    } finally {
      await verify.close();
    }
  }
  return candidate.result;
}
