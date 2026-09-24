import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { toErrorMessage } from '@codelens/shared';

/**
 * Analysis sandbox.
 *
 * Static analyzers execute against untrusted repository content, so the sandbox
 * exists to bound what that content can reach:
 *
 *   - a per-run temporary directory, removed afterwards regardless of outcome
 *   - only the PR's changed files are materialized, never a full clone
 *   - every child process gets a hard timeout and an output cap
 *   - the environment is stripped: no inherited credentials, proxies or tokens
 *
 * Writing only the changed files is also what makes analysis fast enough to run
 * synchronously inside a review: a full clone of a large monorepo would dominate
 * the runtime, and analyzers would spend it on files nobody is reviewing.
 */

export interface SandboxFile {
  path: string;
  content: string;
}

export class AnalysisSandbox {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(baseDir: string, runId: string): Promise<AnalysisSandbox> {
    // Hash the runId so a caller-supplied value cannot traverse out of baseDir.
    const safeId = createHash('sha256').update(runId).digest('hex').slice(0, 24);
    const root = resolve(baseDir, safeId);
    await mkdir(root, { recursive: true });
    return new AnalysisSandbox(root);
  }

  /**
   * Write files into the sandbox.
   *
   * Paths are validated to stay inside the root: a repository could legitimately
   * contain `../` in a filename, and GitHub would happily report it.
   */
  async writeFiles(files: readonly SandboxFile[]): Promise<string[]> {
    const written: string[] = [];

    for (const file of files) {
      const target = resolve(this.root, file.path);

      if (!target.startsWith(this.root)) {
        // Path traversal attempt; skip rather than fail the whole run.
        continue;
      }

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
      written.push(file.path);
    }

    return written;
  }

  async writeConfig(filename: string, content: string): Promise<string> {
    const target = join(this.root, filename);
    await writeFile(target, content, 'utf8');
    return target;
  }

  /**
   * Run a command inside the sandbox.
   *
   * Never throws on a non-zero exit: analyzers signal "findings present" that way,
   * and the caller needs stdout regardless. Failure is reported in the result.
   */
  async exec(
    command: string,
    args: readonly string[],
    options: { timeoutMs?: number; maxOutputBytes?: number; cwd?: string } = {},
  ): Promise<ExecResult> {
    const { timeoutMs = 120_000, maxOutputBytes = 32 * 1024 * 1024 } = options;
    const startedAt = Date.now();

    // On Windows, `npm`, `npx` and most Node CLIs are `.cmd` shims. `spawn` with
    // `shell: false` performs no PATHEXT resolution, so it reports ENOENT for a tool that is
    // plainly installed — which surfaced as "npm is not available" on a machine with npm.
    //
    // Resolving the extension explicitly is preferable to enabling `shell: true`, which would
    // pass the command line through cmd.exe and reintroduce shell-injection risk in a component
    // whose entire purpose is running analyzers over untrusted repository content.
    const resolvedCommand = resolveExecutable(command);

    return new Promise<ExecResult>((resolvePromise) => {
      let child;

      try {
        child = spawn(resolvedCommand, [...args], {
          cwd: options.cwd ?? this.root,
          // Never inherit the parent environment: it holds DATABASE_URL,
          // GITHUB tokens and LLM API keys, none of which an analyzer needs.
          env: {
            PATH: process.env.PATH ?? '',
            HOME: this.root,
            // Semgrep and ESLint both respect these.
            NO_COLOR: '1',
            CI: '1',
            SEMGREP_SEND_METRICS: 'off',
            ...(process.platform === 'win32'
              ? {
                  SystemRoot: process.env.SystemRoot ?? '',
                  COMSPEC: process.env.COMSPEC ?? '',
                  TEMP: this.root,
                  TMP: this.root,
                  APPDATA: this.root,
                  LOCALAPPDATA: this.root,
                  PATHEXT: process.env.PATHEXT ?? '',
                }
              : { TMPDIR: this.root }),
          },
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        resolvePromise({
          stdout: '',
          stderr: toErrorMessage(error),
          exitCode: null,
          timedOut: false,
          spawnFailed: true,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        // Cap accumulation rather than buffering an unbounded analyzer dump.
        if (stdoutBytes <= maxOutputBytes) stdoutChunks.push(chunk);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= maxOutputBytes) stderrChunks.push(chunk);
      });

      const settle = (exitCode: number | null, spawnFailed: boolean, extraStderr = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        resolvePromise({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8') + extraStderr,
          exitCode,
          timedOut,
          spawnFailed,
          durationMs: Date.now() - startedAt,
        });
      };

      child.on('error', (error) => {
        // ENOENT here means the analyzer binary is not installed, which is a
        // SKIPPED result rather than a failure.
        settle(null, true, toErrorMessage(error));
      });

      child.on('close', (code) => settle(code, false));
    });
  }

  async destroy(): Promise<void> {
    try {
      await rm(this.root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leaked temp directory is not worth failing a review over; the
      // directory name is deterministic so it is reused and cleaned next run.
    }
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Null when the process was killed or never started. */
  exitCode: number | null;
  timedOut: boolean;
  /** True when the binary could not be launched, e.g. not installed. */
  spawnFailed: boolean;
  durationMs: number;
}

/**
 * Resolve a bare command name to something `spawn` can execute without a shell.
 *
 * A no-op on POSIX. On Windows it walks PATH looking for the command with each PATHEXT
 * extension appended, which is the resolution `shell: true` would otherwise provide.
 */
function resolveExecutable(command: string): string {
  if (process.platform !== 'win32') return command;
  // An absolute or extensioned path needs no resolution.
  if (command.includes('/') || command.includes('\\') || /\.[a-z]+$/i.test(command)) {
    return command;
  }

  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);

  for (const directory of (process.env.PATH ?? '').split(';').filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Fall through unchanged so the caller still receives a clear ENOENT.
  return command;
}

/** Stable fingerprint for deduplicating a finding across runs. */
export function fingerprintFinding(params: {
  analyzer: string;
  ruleId: string;
  path: string | null;
  message: string;
}): string {
  // The message is normalized so variable numbers (line counts, sizes) do not
  // produce a different fingerprint for what is the same finding.
  const normalizedMessage = params.message
    .toLowerCase()
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  return createHash('sha256')
    .update(`${params.analyzer}|${params.ruleId}|${params.path ?? ''}|${normalizedMessage}`)
    .digest('hex')
    .slice(0, 32);
}
