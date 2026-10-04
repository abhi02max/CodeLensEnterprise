import { constants } from 'node:fs';
import { lstat, mkdir, open, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LIMITS, validateInput, checkCompatibility } from './contracts';
import { readFrame, encodeFrame } from './frame';

export async function prepareSource(raw: unknown, root = '/input') {
  const { input, digest } = validateInput(raw);
  checkCompatibility(input);
  const parent = await lstat(root);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.())
    throw new Error('INPUT_ROOT_REJECTED');
  const directories = new Set<string>([root]);
  for (const file of input.files) {
    const target = join(root, file.path),
      directory = dirname(target);
    const components = directory.slice(root.length).split('/').filter(Boolean);
    let current = root;
    for (const part of components) {
      current = join(current, part);
      if (!directories.has(current)) {
        await mkdir(current, { mode: 0o755 });
        const st = await lstat(current);
        if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.())
          throw new Error('INPUT_PARENT_REJECTED');
        directories.add(current);
      }
    }
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o444,
    );
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.())
        throw new Error('INPUT_FILE_REJECTED');
      await handle.writeFile(file.content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const directory of [...directories].reverse()) await chmod(directory, 0o555);
  return { version: 1, digest };
}
if (require.main === module) {
  void readFrame(process.stdin, LIMITS.frameBytes)
    .then(prepareSource)
    .then((result) => process.stdout.write(encodeFrame(result, 1024)))
    .catch(() => {
      process.stderr.write('INPUT_PREPARATION_FAILED\n');
      process.exitCode = 1;
    });
}
