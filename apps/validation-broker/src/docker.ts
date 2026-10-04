import { request } from 'node:http';
import type { Duplex } from 'node:stream';
export interface Daemon {
  call(method: string, path: string, body?: unknown, deadlineAt?: number): Promise<any>;
  attach(id: string, stdin: boolean, deadlineAt?: number): Promise<Duplex>;
}
/** Only this backend transport receives daemon authority; it is never part of a request. */
export class DockerTransport implements Daemon {
  constructor(private readonly socketPath = '/var/run/docker.sock') {}
  call(method: string, path: string, body?: unknown, deadlineAt?: number): Promise<any> {
    const remaining = Math.min(10000, deadlineAt === undefined ? 10000 : deadlineAt - Date.now());
    if (remaining <= 0) return Promise.reject(new Error('DAEMON_DEADLINE'));
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
            if (size > 512 * 1024) res.destroy(new Error('DAEMON_BOUND'));
            else chunks.push(chunk);
          });
          res.once('error', () => reject(new Error('DAEMON_UNAVAILABLE')));
          res.once('end', () => {
            if (res.statusCode === 404 && method === 'GET') {
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
              reject(new Error('DAEMON_RESPONSE_REJECTED'));
            }
          });
        },
      );
      const timer = setTimeout(() => req.destroy(new Error('DAEMON_TIMEOUT')), remaining);
      req.once('close', () => clearTimeout(timer));
      req.once('error', () => reject(new Error('DAEMON_UNAVAILABLE')));
      req.end(bytes);
    });
  }
  attach(id: string, stdin: boolean, deadlineAt?: number): Promise<Duplex> {
    const remaining = Math.min(10000, deadlineAt === undefined ? 10000 : deadlineAt - Date.now());
    if (remaining <= 0) return Promise.reject(new Error('DAEMON_DEADLINE'));
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath,
        method: 'POST',
        path: `/v1.51/containers/${id}/attach?stream=1&stdin=${stdin ? 1 : 0}&stdout=1&stderr=1`,
        headers: { Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      const timer = setTimeout(() => req.destroy(), remaining);
      req.once('close', () => clearTimeout(timer));
      req.once('upgrade', (_res, socket, head) => {
        clearTimeout(timer);
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      req.once('response', (res) => {
        res.destroy();
        reject(new Error('DAEMON_ATTACH_FAILED'));
      });
      req.once('error', () => reject(new Error('DAEMON_ATTACH_FAILED')));
      req.end();
    });
  }
}
