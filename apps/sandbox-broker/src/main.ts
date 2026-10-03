import { createServer } from 'node:net';
import { chmod, lstat, readFile, unlink } from 'node:fs/promises';
import { readFrame, encodeFrame, MATERIALIZATION_LIMITS } from '@codelens/patch-core';
import { BrokerAuthenticator, signBrokerResponse, safeBrokerFailure } from './protocol';
import { NonceStore } from './nonce-store';
import { FixedPolicyLauncher } from './launcher';
import { DockerTransport } from './docker';
import { BROKER_POLICY } from './policy';

const socketPath = '/control/broker.sock';
void (async () => {
  const key = await readFile('/run/secrets/broker-key');
  const auth = new BrokerAuthenticator(key);
  const image = process.env['CODELENS_EXECUTOR_IMAGE_ID'] ?? '';
  const seccomp = await readFile('/policy/seccomp.json', 'utf8');
  const launcher = new FixedPolicyLauncher(
    new DockerTransport(),
    image,
    seccomp,
    key,
    '/journal/containers',
    process.env['CODELENS_SANDBOX_NAMESPACE'],
  );
  const nonces = new NonceStore('/journal/nonces');
  await nonces.initialize();
  await launcher.reconcile();
  try {
    const old = await lstat(socketPath);
    if (!old.isSocket()) throw new Error('BROKER_SOCKET_POLICY');
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let connections = 0;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (connections >= BROKER_POLICY.pendingConnections) {
      socket.destroy();
      return;
    }
    connections++;
    const started = Date.now(),
      cancelled = new AbortController();
    socket.once('close', () => cancelled.abort());
    socket.on('error', () => undefined);
    const deadline = setTimeout(() => socket.destroy(), BROKER_POLICY.deadlineMs);
    void (async () => {
      let nonce: string | undefined;
      try {
        const raw = await readFrame(socket, MATERIALIZATION_LIMITS.inputBytes);
        const payload = auth.consume(raw);
        const envelope = raw as { nonce: string; issuedAt: number; deadlineAt: number };
        nonce = envelope.nonce;
        await nonces.consume(nonce, envelope.issuedAt + BROKER_POLICY.authenticationAgeMs);
        const result = await launcher.materialize(
          payload,
          cancelled.signal,
          Math.min(
            envelope.deadlineAt - Date.now(),
            BROKER_POLICY.deadlineMs - (Date.now() - started),
          ),
        );
        socket.end(
          encodeFrame(signBrokerResponse(key, nonce, result), MATERIALIZATION_LIMITS.outputBytes),
        );
      } catch (error) {
        const code = safeBrokerFailure(error);
        if (!socket.destroyed && nonce)
          socket.end(
            encodeFrame(
              signBrokerResponse(key, nonce, { version: 1, status: 'FAILED', code }),
              MATERIALIZATION_LIMITS.outputBytes,
            ),
          );
        else socket.destroy();
      } finally {
        clearTimeout(deadline);
        connections--;
      }
    })();
  });
  server.listen(socketPath, () => {
    void chmod(socketPath, 0o660);
  });
  const stop = () => {
    server.close();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
})().catch(() => {
  process.stderr.write('BROKER_STARTUP_FAILED\n');
  process.exitCode = 1;
});
