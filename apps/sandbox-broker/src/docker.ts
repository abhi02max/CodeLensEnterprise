import { request } from 'node:http';
import type { Duplex } from 'node:stream';
import { BROKER_POLICY } from './policy';

/** Narrow internal daemon transport. It is not exposed by the broker protocol. */
export class DockerTransport {
  constructor(private readonly socketPath = '/var/run/docker.sock') {}
  async call(method: string, path: string, body?: unknown, deadlineAt?: number): Promise<unknown> {
    const maximumMs = Math.min(
      BROKER_POLICY.daemonOperationMs,
      deadlineAt === undefined ? BROKER_POLICY.daemonOperationMs : deadlineAt - Date.now(),
    );
    if (maximumMs <= 0) throw new Error('DAEMON_UNAVAILABLE');
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path: '/v1.51' + path,
          headers: bytes
            ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length }
            : {},
        },
        (res) => {
          let size = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 256 * 1024) {
              res.destroy();
              reject(new Error('DAEMON_RESPONSE_BOUND'));
            } else chunks.push(chunk);
          });
          res.on('error', () => reject(new Error('DAEMON_UNAVAILABLE')));
          res.on('end', () => {
            if (
              res.statusCode === 404 &&
              method === 'GET' &&
              /^\/containers\/[^/]+\/json$/.test(path)
            ) {
              resolve(null);
              return;
            }
            if (!res.statusCode || res.statusCode >= 300) {
              reject(new Error('DAEMON_OPERATION_FAILED'));
              return;
            }
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              resolve(text ? JSON.parse(text) : {});
            } catch {
              reject(new Error('DAEMON_RESPONSE_INVALID'));
            }
          });
        },
      );
      req.setTimeout(maximumMs, () => req.destroy(new Error('DAEMON_TIMEOUT')));
      const deadline = setTimeout(() => req.destroy(new Error('DAEMON_TIMEOUT')), maximumMs);
      req.once('close', () => clearTimeout(deadline));
      req.on('error', () => reject(new Error('DAEMON_UNAVAILABLE')));
      req.end(bytes);
    });
  }
  async attach(id: string): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath,
        method: 'POST',
        path: `/v1.51/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        headers: { Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      req.setTimeout(BROKER_POLICY.daemonOperationMs, () => req.destroy());
      const deadline = setTimeout(() => req.destroy(), BROKER_POLICY.daemonOperationMs);
      req.once('close', () => clearTimeout(deadline));
      req.on('upgrade', (_res, socket, head) => {
        clearTimeout(deadline);
        req.setTimeout(0);
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      req.on('response', (res) => {
        res.destroy();
        reject(new Error('DAEMON_ATTACH_FAILED'));
      });
      req.on('error', () => reject(new Error('DAEMON_ATTACH_FAILED')));
      req.end();
    });
  }
}
