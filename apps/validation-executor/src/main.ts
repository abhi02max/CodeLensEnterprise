import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectReport } from './collect';
import { ProfileId } from './contracts';

const REPORT_MARKER = '\x1eCODELENS_RUNNER_V1:';
async function main() {
  const profile = ProfileId.parse(process.argv[2]);
  if (profile === 'typescript-typecheck-v1') {
    const ts =
      require('/build/apps/validation-executor/node_modules/typescript') as typeof import('typescript');
    const files: string[] = [];
    async function visit(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(path);
      }
    }
    await visit('/input');
    const program = ts.createProgram(files, {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      allowJs: true,
      checkJs: true,
      types: ['node'],
      typeRoots: ['/build/apps/validation-executor/node_modules/@types'],
      baseUrl: '/input',
      paths: { vitest: ['/build/apps/validation-executor/node_modules/vitest'] },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    process.stdout.write(
      ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => '/input',
        getNewLine: () => '\n',
      }),
    );
    await writeFile(
      '/output/report.json',
      JSON.stringify({
        version: 1,
        kind: 'typecheck',
        passed: diagnostics.length === 0 ? 1 : 0,
        failed: diagnostics.length === 0 ? 0 : 1,
        total: 1,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    process.exitCode = diagnostics.length === 0 ? 0 : 1;
  } else {
    const child = spawn('/nodejs/bin/node', ['/policy/vitest-runner.mjs'], {
      cwd: '/input',
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: false,
      env: { ...process.env },
    });
    process.exitCode = await new Promise<number>((resolve) => {
      child.once('error', () => resolve(125));
      child.once('exit', (code) => resolve(code ?? 125));
    });
  }
  try {
    process.stdout.write('\n' + REPORT_MARKER + JSON.stringify(await collectReport()) + '\n');
  } catch {
    process.stdout.write('\n' + REPORT_MARKER + '{"rejected":true}\n');
  }
  // Reading the fixed config here also makes unexpected missing policy a failed execution.
  await readFile('/policy/vitest.config.mjs');
}
void main().catch(() => {
  process.stderr.write('VALIDATION_RUNNER_FAILED\n');
  process.exitCode = 125;
});
