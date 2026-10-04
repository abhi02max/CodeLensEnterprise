import { createServer } from 'node:net';
import { chmod, lstat, readFile, unlink } from 'node:fs/promises';
import { LIMITS, readFrame, encodeFrame } from '@codelens/validation-executor';
import { authenticate, signResult } from './protocol';
import { approvedProfile } from './profile';
import { DockerTransport } from './docker';
import { DockerValidationBackend } from './docker-backend';
import { ReplayStore } from './replay';

void (async () => {
  if (
    process.env['CODELENS_VALIDATION_BACKEND'] !== 'docker-local-proof' ||
    process.env['CODELENS_VALIDATION_LOCAL_PROOF'] !== 'true'
  )
    throw new Error('BACKEND_NOT_SUPPORTED');
  const key = await readFile('/run/secrets/validation-key');
  const image = process.env['CODELENS_VALIDATION_IMAGE'] ?? '';
  const daemon = new DockerTransport();
  const metadata = await daemon.call('GET', '/images/' + image + '/json');
  if (!metadata || metadata.Id !== image || metadata.Architecture !== 'amd64')
    throw new Error('PINNED_IMAGE_REQUIRED');
  const bundleDigest = metadata.Config.Labels?.['com.codelens.validation.bundle'];
  const configurationDigest = metadata.Config.Labels?.['com.codelens.validation.configuration'];
  approvedProfile('vitest-unit-v1', image, bundleDigest, configurationDigest);
  const backend = new DockerValidationBackend(
    daemon,
    await readFile('/policy/seccomp.json', 'utf8'),
    key,
    process.env['CODELENS_VALIDATION_NAMESPACE'] ?? '',
    '/journal/resources',
  );
  await backend.reconcile();
  const replay = new ReplayStore('/journal/nonces');
  const socketPath = '/control/validation.sock';
  try {
    if (!(await lstat(socketPath)).isSocket()) throw new Error('CONTROL_PATH_REJECTED');
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let active = 0;
  const controllers = new Set<AbortController>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (active >= 4) {
      socket.destroy();
      return;
    }
    active++;
    const acceptedAt = Date.now();
    const cancellation = new AbortController();
    controllers.add(cancellation);
    socket.once('close', () => cancellation.abort());
    socket.on('error', () => undefined);
    const timeout = setTimeout(() => {
      cancellation.abort();
      socket.destroy();
    }, LIMITS.operationMs);
    void (async () => {
      try {
        const request = authenticate(key, await readFrame(socket, LIMITS.frameBytes));
        socket.on('data', () => socket.destroy());
        await replay.consume(request.nonce, request.deadlineAt + 60000);
        const result = await backend.execute(
          request.input,
          approvedProfile(request.input.profile, image, bundleDigest, configurationDigest),
          request.nonce,
          Math.min(request.deadlineAt, acceptedAt + LIMITS.operationMs),
          cancellation.signal,
        );
        if (!socket.destroyed)
          socket.end(encodeFrame(signResult(key, request.nonce, result), LIMITS.resultBytes));
      } catch {
        socket.destroy();
      } finally {
        clearTimeout(timeout);
        controllers.delete(cancellation);
        active--;
      }
    })();
  });
  server.listen(socketPath, () => {
    void chmod(socketPath, 0o660);
  });
  const stop = () => {
    server.close();
    for (const controller of controllers) controller.abort();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
})().catch(() => {
  process.stderr.write('VALIDATION_BROKER_STARTUP_FAILED\n');
  process.exitCode = 1;
});
