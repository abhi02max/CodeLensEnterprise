import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  LIMITS,
  validateInput,
  checkCompatibility,
  encodeFrame,
  ResultSchema,
  type ValidationInput,
  type ValidationResult,
} from '@codelens/validation-executor';
import type { ValidationBackend } from './backend';
import { containerPolicy, type ApprovedProfile } from './profile';
import type { Daemon } from './docker';
import { outputFact, runnerReported } from './output';

interface Resource {
  name: string;
  type: 'container' | 'volume';
  acknowledged: boolean;
  id?: string;
}
interface Journal {
  version: 1;
  image: string;
  namespace: string;
  resources: Resource[];
  mac: string;
}
type Termination = ValidationResult['observed']['termination'];
export class DockerValidationBackend implements ValidationBackend {
  readonly kind = 'docker-local-proof' as const;
  private busy = false;
  private uncertain = false;
  constructor(
    private readonly daemon: Daemon,
    private readonly seccomp: string,
    private readonly key: Buffer,
    private readonly namespace: string,
    private readonly journal: string,
  ) {
    if (!/^codelens_[a-z0-9_]{1,48}$/.test(namespace) || key.length !== 32)
      throw new Error('VALIDATION_DEPLOYMENT_REJECTED');
  }
  private signature(record: Omit<Journal, 'mac'>) {
    return createHmac('sha256', this.key)
      .update('validation-resources-v1\0' + JSON.stringify(record))
      .digest('hex');
  }
  private labels(name: string, image: string) {
    return {
      'com.codelens.validation.namespace': this.namespace,
      'com.codelens.validation.owner': createHmac('sha256', this.key)
        .update('validation-owner-v1\0' + name + '\0' + image)
        .digest('hex'),
    };
  }
  private async save(path: string, record: Journal, exclusive = false) {
    const { mac: _mac, ...body } = record;
    record.mac = this.signature(body);
    const handle = await open(path, exclusive ? 'wx' : 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(this.journal, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async dispose(record: Journal, path: string, deadlineAt?: number) {
    const { mac, ...body } = record;
    if (
      mac !== this.signature(body) ||
      record.version !== 1 ||
      record.namespace !== this.namespace ||
      !/^sha256:[a-f0-9]{64}$/.test(record.image) ||
      record.resources.length > 3
    )
      throw new Error('CLEANUP_IDENTITY_REJECTED');
    for (const resource of [...record.resources].reverse()) {
      if (!resource.name.startsWith(this.namespace + '-') || !/^[a-z0-9_-]+$/.test(resource.name))
        throw new Error('CLEANUP_IDENTITY_REJECTED');
      const endpoint =
        resource.type === 'container'
          ? '/containers/' + resource.name + '/json'
          : '/volumes/' + resource.name;
      const item = await this.daemon.call('GET', endpoint, undefined, deadlineAt);
      if (item) {
        const labels = resource.type === 'container' ? item.Config.Labels : item.Labels;
        const expected = this.labels(resource.name, record.image);
        if (
          Object.entries(expected).some(([key, value]) => labels?.[key] !== value) ||
          (resource.type === 'container' &&
            (item.Name !== '/' + resource.name ||
              item.Config.Image !== record.image ||
              (resource.id && item.Id !== resource.id))) ||
          (resource.type === 'volume' && item.Name !== resource.name)
        )
          throw new Error('CLEANUP_IDENTITY_REJECTED');
        await this.daemon.call(
          'DELETE',
          resource.type === 'container'
            ? '/containers/' + item.Id + '?force=1&v=1'
            : '/volumes/' + resource.name,
          undefined,
          deadlineAt,
        );
        if (await this.daemon.call('GET', endpoint, undefined, deadlineAt))
          throw new Error('CLEANUP_UNCERTAIN');
      } else if (!resource.acknowledged) throw new Error('CLEANUP_UNCERTAIN');
    }
    await unlink(path);
  }
  async reconcile() {
    await mkdir(this.journal, { recursive: true, mode: 0o700 });
    this.uncertain = true;
    const files = await readdir(this.journal);
    if (files.length > 16) throw new Error('JOURNAL_BOUND');
    for (const name of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error('JOURNAL_REJECTED');
      const path = join(this.journal, name),
        bytes = await readFile(path);
      if (bytes.length > 4096) throw new Error('JOURNAL_BOUND');
      await this.dispose(JSON.parse(bytes.toString('utf8')) as Journal, path);
    }
    this.uncertain = false;
  }
  async execute(
    raw: ValidationInput,
    profile: ApprovedProfile,
    correlation: string,
    deadlineAt: number,
    signal: AbortSignal,
  ) {
    if (this.busy || this.uncertain) throw new Error('BUSY_OR_CLEANUP_UNCERTAIN');
    const { input, digest } = validateInput(raw),
      startedAt = Date.now();
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let termination: Termination = 'INFRASTRUCTURE',
      started = false,
      exitCode: number | null = null,
      oom = false;
    let complete = true,
      status: ValidationResult['status'] = 'INFRASTRUCTURE_FAILED';
    const result = () =>
      ResultSchema.parse({
        version: 1,
        profile: profile.id,
        profileVersion: 1,
        policyVersion: 'validation-local-v1',
        image: profile.image,
        bundleDigest: profile.bundleDigest,
        configurationDigest: profile.configurationDigest,
        correlation,
        inputDigest: digest,
        status,
        observed: {
          started,
          exitCode,
          termination,
          oom,
          durationMs: Date.now() - startedAt,
          cleanup: this.uncertain ? 'UNCERTAIN' : 'DISPOSED',
          stdout: outputFact(Buffer.concat(stdout), complete, [
            this.key.toString('hex'),
            this.key.toString('base64'),
          ]),
          stderr: outputFact(Buffer.concat(stderr), complete, [
            this.key.toString('hex'),
            this.key.toString('base64'),
          ]),
        },
        runnerReported: runnerReported(
          Buffer.concat(stdout),
          profile.id === 'vitest-unit-v1' ? 'tests' : 'typecheck',
        ),
      });
    try {
      checkCompatibility(input);
    } catch {
      status = 'UNSUPPORTED';
      return result();
    }
    if (deadlineAt - Date.now() <= LIMITS.cleanupMs || signal.aborted)
      throw new Error('DEADLINE_OR_CANCELLED');
    this.busy = true;
    const id = randomUUID(),
      path = join(this.journal, id + '.json');
    const record: Journal = {
      version: 1,
      namespace: this.namespace,
      image: profile.image,
      resources: [],
      mac: '',
    };
    let attached: Duplex | undefined, current: Resource | undefined;
    let timer: NodeJS.Timeout | undefined, phaseTimer: NodeJS.Timeout | undefined;
    let stopped = false;
    const abort = () => {
      stopped = true;
      complete = false;
      termination = signal.aborted ? 'CANCELLED' : 'TIMEOUT';
      attached?.destroy();
    };
    const check = () => {
      if (stopped || signal.aborted || Date.now() >= deadlineAt - LIMITS.cleanupMs)
        throw new Error('WORK_FENCED');
    };
    const create = async (resource: Resource, body: unknown) => {
      check();
      record.resources.push(resource);
      await this.save(path, record);
      check();
      const created = await this.daemon.call(
        'POST',
        resource.type === 'volume' ? '/volumes/create' : '/containers/create?name=' + resource.name,
        body,
        deadlineAt - LIMITS.cleanupMs,
      );
      if (resource.type === 'container') {
        if (!/^[a-f0-9]{64}$/.test(created.Id)) throw new Error('DAEMON_IDENTITY_REJECTED');
        resource.id = created.Id;
      } else if (
        created.Name !== resource.name ||
        Object.entries(this.labels(resource.name, profile.image)).some(
          ([key, value]) => created.Labels?.[key] !== value,
        )
      )
        throw new Error('DAEMON_IDENTITY_REJECTED');
      resource.acknowledged = true;
      await this.save(path, record);
      check();
    };
    const launch = async (prepare: boolean, volume: string) => {
      current = {
        name: `${this.namespace}-${prepare ? 'prepare' : 'execute'}-${id}`,
        type: 'container',
        acknowledged: false,
      };
      await create(
        current,
        containerPolicy(
          profile,
          this.seccomp,
          this.labels(current.name, profile.image),
          volume,
          prepare,
        ),
      );
      attached = await this.daemon.attach(current.id!, prepare, deadlineAt - LIMITS.cleanupMs);
      check();
      const prepOut: Buffer[] = [];
      const reading = (async () => {
        let pending = Buffer.alloc(0),
          outSize = 0,
          errSize = 0;
        for await (const chunk of attached!) {
          check();
          pending = Buffer.concat([pending, chunk]);
          if (pending.length > LIMITS.streamBytes + 16) throw new Error('OUTPUT_LIMIT');
          while (pending.length >= 8) {
            const channel = pending[0],
              length = pending.readUInt32BE(4);
            if (
              (channel !== 1 && channel !== 2) ||
              pending[1] ||
              pending[2] ||
              pending[3] ||
              length > LIMITS.streamBytes
            )
              throw new Error('OUTPUT_LIMIT');
            if (pending.length < length + 8) break;
            const data = Buffer.from(pending.subarray(8, length + 8));
            pending = pending.subarray(length + 8);
            const used = channel === 1 ? outSize : errSize,
              limit = prepare ? 1024 : LIMITS.streamBytes;
            const prefix = data.subarray(0, Math.max(0, limit - used));
            if (prepare) {
              if (channel === 1) prepOut.push(prefix);
              else stderr.push(prefix);
            } else (channel === 1 ? stdout : stderr).push(prefix);
            if (channel === 1) outSize += data.length;
            else errSize += data.length;
            if (outSize > limit || errSize > limit) throw new Error('OUTPUT_LIMIT');
          }
        }
        if (pending.length) throw new Error('STREAM_REJECTED');
      })();
      reading.catch(() => undefined);
      try {
        await this.daemon.call(
          'POST',
          '/containers/' + current.id + '/start',
          undefined,
          deadlineAt - LIMITS.cleanupMs,
        );
        check();
        if (!prepare) {
          started = true;
          phaseTimer = setTimeout(abort, profile.timeoutMs);
        } else attached.end(encodeFrame(input, LIMITS.frameBytes));
        await reading;
        check();
        const state = await this.daemon.call(
          'GET',
          '/containers/' + current.id + '/json',
          undefined,
          deadlineAt - LIMITS.cleanupMs,
        );
        check();
        if (state.State.Running) throw new Error('EXECUTION_STILL_RUNNING');
        if (prepare) {
          const bytes = Buffer.concat(prepOut);
          if (
            state.State.ExitCode !== 0 ||
            bytes.length < 4 ||
            bytes.readUInt32BE(0) !== bytes.length - 4 ||
            JSON.parse(bytes.subarray(4).toString()).digest !== digest
          )
            throw new Error('SEAL_REJECTED');
        } else {
          exitCode = state.State.ExitCode;
          oom = !!state.State.OOMKilled;
        }
      } catch (error) {
        stopped = true;
        if ((error as Error).message === 'OUTPUT_LIMIT') {
          termination = 'OUTPUT_LIMIT';
          complete = false;
        }
        attached?.destroy();
        await reading.catch(() => undefined);
        throw error;
      } finally {
        if (phaseTimer) clearTimeout(phaseTimer);
        attached?.destroy();
      }
    };
    try {
      await this.save(path, record, true);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, Math.max(1, deadlineAt - LIMITS.cleanupMs - Date.now()));
      const volume = {
        name: this.namespace + '-input-' + id,
        type: 'volume' as const,
        acknowledged: false,
      };
      await create(volume, {
        Name: volume.name,
        Driver: 'local',
        Labels: this.labels(volume.name, profile.image),
      });
      await launch(true, volume.name);
      await launch(false, volume.name);
      termination = 'EXITED';
      status = 'VALIDATION_EXECUTED';
    } catch {
      const category = termination as Termination;
      if (category === 'CANCELLED') status = 'CANCELLED';
      else if (started && (category === 'TIMEOUT' || category === 'OUTPUT_LIMIT'))
        status = 'VALIDATION_EXECUTED';
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (phaseTimer) clearTimeout(phaseTimer);
      signal.removeEventListener('abort', abort);
      attached?.destroy();
      try {
        if (current?.id && started) {
          const state = await this.daemon.call(
            'GET',
            '/containers/' + current.id + '/json',
            undefined,
            deadlineAt,
          );
          if (state?.State.Running)
            await this.daemon.call(
              'POST',
              '/containers/' + current.id + '/kill?signal=SIGKILL',
              undefined,
              deadlineAt,
            );
          const ended = await this.daemon.call(
            'GET',
            '/containers/' + current.id + '/json',
            undefined,
            deadlineAt,
          );
          if (ended) {
            exitCode = ended.State.ExitCode;
            oom = !!ended.State.OOMKilled;
          }
        }
        await this.dispose(record, path, deadlineAt);
      } catch {
        this.uncertain = true;
        status = 'INFRASTRUCTURE_FAILED';
      }
      this.busy = false;
    }
    return result();
  }
}
