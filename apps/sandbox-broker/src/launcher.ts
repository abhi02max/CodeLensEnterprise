import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, type Duplex } from 'node:stream';
import {
  encodeFrame,
  readFrame,
  materializeCandidate,
  MATERIALIZATION_LIMITS,
} from '@codelens/patch-core';
import { DockerTransport } from './docker';
import { BROKER_POLICY, executorPolicy } from './policy';

interface RecordIdentity {
  version: 1;
  name: string;
  proof: string;
  image: string;
  containerId?: string;
}
interface Inspection {
  Id: string;
  Name: string;
  Config: { Image: string; Labels: Record<string, string> };
  State: { Running: boolean; ExitCode: number };
}

export class FixedPolicyLauncher {
  private busy = false;
  private cleanupUncertain = false;
  constructor(
    private readonly docker: DockerTransport,
    private readonly image: string,
    private readonly seccomp: string,
    private readonly key: Buffer,
    private readonly journal: string,
    private readonly namespace = 'codelens-patch-sandbox',
  ) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(namespace)) throw new Error('BROKER_NAMESPACE_REQUIRED');
    executorPolicy(image, seccomp, {});
  }
  private proof(name: string, image = this.image) {
    return createHmac('sha256', this.key)
      .update('owned-container-v1\0' + name + '\0' + image)
      .digest('hex');
  }
  private async cleanup(record: RecordIdentity, path: string, deadlineAt?: number) {
    if (
      record.version !== 1 ||
      !record.name.startsWith(this.namespace + '-executor-') ||
      !/^sha256:[a-f0-9]{64}$/.test(record.image) ||
      record.proof !== this.proof(record.name, record.image) ||
      (record.containerId !== undefined && !/^[a-f0-9]{64}$/.test(record.containerId))
    )
      throw new Error('CLEANUP_IDENTITY_REJECTED');
    const container = (await this.docker.call(
      'GET',
      `/containers/${record.name}/json`,
      undefined,
      deadlineAt,
    )) as Inspection | null;
    if (container) {
      if (
        container.Name !== '/' + record.name ||
        container.Config.Image !== record.image ||
        (record.containerId !== undefined && container.Id !== record.containerId) ||
        container.Config.Labels['com.codelens.broker.project'] !== this.namespace ||
        container.Config.Labels['com.codelens.broker.proof'] !== record.proof
      )
        throw new Error('CLEANUP_IDENTITY_REJECTED');
      await this.docker.call(
        'DELETE',
        `/containers/${container.Id}?force=1&v=1`,
        undefined,
        deadlineAt,
      );
      if (
        (await this.docker.call(
          'GET',
          `/containers/${record.name}/json`,
          undefined,
          deadlineAt,
        )) !== null
      )
        throw new Error('CLEANUP_FAILED');
    } else if (!record.containerId) {
      // A timed-out create may still settle in the daemon. Absence is not cleanup proof.
      throw new Error('CLEANUP_UNCERTAIN');
    }
    await unlink(path);
  }
  async reconcile() {
    await mkdir(this.journal, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.journal)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) throw new Error('JOURNAL_IDENTITY_REJECTED');
      const path = join(this.journal, file);
      const bytes = await readFile(path);
      if (bytes.length > 1024) throw new Error('JOURNAL_BOUND');
      await this.cleanup(JSON.parse(bytes.toString('utf8')), path);
    }
    this.cleanupUncertain = false;
  }
  async materialize(
    raw: unknown,
    signal?: AbortSignal,
    remainingMs: number = BROKER_POLICY.deadlineMs,
  ) {
    if (this.busy || this.cleanupUncertain) throw new Error('BROKER_BUSY_OR_CLEANUP_UNCERTAIN');
    if (!Number.isFinite(remainingMs) || remainingMs <= BROKER_POLICY.cleanupReserveMs)
      throw new Error('BROKER_DEADLINE');
    const hardDeadline = Date.now() + Math.min(remainingMs, BROKER_POLICY.deadlineMs);
    const workDeadline = hardDeadline - BROKER_POLICY.cleanupReserveMs;
    this.busy = true;
    let record: RecordIdentity | undefined, path: string | undefined, attached: Duplex | undefined;
    let timer: NodeJS.Timeout | undefined;
    let expired = false;
    let creationIssued = false;
    let running: Promise<unknown> | undefined;
    const check = () => {
      if (expired || signal?.aborted || Date.now() >= workDeadline)
        throw new Error('BROKER_DEADLINE');
    };
    let abort: (() => void) | undefined;
    try {
      const expected = materializeCandidate(raw).result;
      check();
      const id = randomUUID(),
        name = this.namespace + '-executor-' + id;
      record = { version: 1, name, proof: this.proof(name), image: this.image };
      path = join(this.journal, id + '.json');
      // Persist ownership before create, so a lost daemon response has a recoverable name.
      await writeFile(path, JSON.stringify(record), { flag: 'wx', mode: 0o600, flush: true });
      check();
      const labels = {
        'com.codelens.broker.project': this.namespace,
        'com.codelens.broker.proof': record.proof,
      };
      const operation = async () => {
        check();
        creationIssued = true;
        const created = (await this.docker.call(
          'POST',
          `/containers/create?name=${name}`,
          executorPolicy(this.image, this.seccomp, labels),
        )) as { Id: string };
        check();
        if (!/^[a-f0-9]{64}$/.test(created.Id)) throw new Error('DAEMON_IDENTITY_INVALID');
        record!.containerId = created.Id;
        await writeFile(path!, JSON.stringify(record), { mode: 0o600, flush: true });
        check();
        attached = await this.docker.attach(created.Id);
        check();
        const output = new PassThrough();
        const decoded = this.stdout(attached, output);
        const response = readFrame(output, MATERIALIZATION_LIMITS.outputBytes);
        // Observe all attached promises before starting; cleanup never logs daemon/source data.
        const received = Promise.all([decoded, response]);
        received.catch(() => undefined);
        await this.docker.call('POST', `/containers/${created.Id}/start`);
        check();
        attached.end(encodeFrame(raw, MATERIALIZATION_LIMITS.inputBytes));
        const [, result] = await received;
        const exit = (await this.docker.call(
          'POST',
          `/containers/${created.Id}/wait?condition=not-running`,
        )) as { StatusCode: number };
        if (exit.StatusCode !== 0) throw new Error('EXECUTOR_RESULT_REJECTED');
        const state = (await this.docker.call(
          'GET',
          `/containers/${created.Id}/json`,
        )) as Inspection;
        if (
          state.State.Running ||
          state.State.ExitCode !== 0 ||
          JSON.stringify(result) !==
            JSON.stringify({ version: 1, status: 'MATERIALIZED', result: expected })
        )
          throw new Error('EXECUTOR_RESULT_REJECTED');
        return result;
      };
      const timeout = new Promise<never>((_resolve, reject) => {
        abort = () => {
          expired = true;
          attached?.destroy();
          reject(new Error('BROKER_DEADLINE'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, Math.max(1, workDeadline - Date.now()));
      });
      running = operation();
      return await Promise.race([running, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
      attached?.destroy();
      // Fence late create/attach/start settlement before cleanup; never launch after timeout.
      if (running) await running.catch(() => undefined);
      try {
        if (record && path) {
          if (creationIssued) await this.cleanup(record, path, hardDeadline);
          else {
            try {
              await unlink(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        }
      } catch {
        this.cleanupUncertain = true;
        throw new Error('BROKER_CLEANUP_UNCERTAIN');
      } finally {
        this.busy = false;
      }
    }
  }
  private async stdout(stream: Duplex, output: PassThrough) {
    let buffer = Buffer.alloc(0),
      total = 0;
    try {
      for await (const chunk of stream) {
        if (buffer.length + chunk.length > MATERIALIZATION_LIMITS.outputBytes + 12)
          throw new Error('EXECUTOR_OUTPUT_BOUND');
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        while (buffer.length >= 8) {
          const length = buffer.readUInt32BE(4);
          if (
            length > MATERIALIZATION_LIMITS.outputBytes ||
            buffer[0] !== 1 ||
            buffer[1] !== 0 ||
            buffer[2] !== 0 ||
            buffer[3] !== 0
          )
            throw new Error('EXECUTOR_OUTPUT_REJECTED');
          if (buffer.length < 8 + length) break;
          total += length;
          if (total > MATERIALIZATION_LIMITS.outputBytes + 4)
            throw new Error('EXECUTOR_OUTPUT_BOUND');
          output.write(buffer.subarray(8, 8 + length));
          buffer = buffer.subarray(8 + length);
        }
      }
      if (buffer.length) throw new Error('EXECUTOR_OUTPUT_INCOMPLETE');
      output.end();
    } catch {
      output.destroy(new Error('EXECUTOR_OUTPUT_REJECTED'));
      throw new Error('EXECUTOR_OUTPUT_REJECTED');
    }
  }
}
