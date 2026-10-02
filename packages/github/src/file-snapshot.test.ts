import { afterEach, expect, it, vi } from 'vitest';
import { GithubClient } from './client';

afterEach(() => vi.restoreAllMocks());
function fixture(bytes = Buffer.from('export const value = 1;')) {
  const client = new GithubClient({ accessToken: 'synthetic-only' });
  const request = vi.spyOn(
    client as unknown as { request: (label: string, fn: unknown) => Promise<unknown> },
    'request',
  );
  request.mockResolvedValue({
    data: {
      type: 'file',
      size: bytes.length,
      encoding: 'base64',
      content: bytes.toString('base64'),
      sha: 'b'.repeat(40),
    },
  });
  return { client, request };
}
it('requires a full commit identity and returns text with its upstream blob hash', async () => {
  const { client, request } = fixture();
  await expect(client.getFileSnapshot('safe/repo', 'Src/File.ts', 'main')).rejects.toThrow(
    'Exact commit',
  );
  expect(request).not.toHaveBeenCalled();
  expect(await client.getFileSnapshot('safe/repo', 'Src/File.ts', 'a'.repeat(40))).toEqual({
    content: 'export const value = 1;',
    blobSha: 'b'.repeat(40),
  });
});
it.each([Buffer.from([0]), Buffer.from([0xff, 0xfe]), Buffer.alloc(1024 * 1024 + 1, 65)])(
  'rejects unsupported binary/oversized source bytes',
  async (bytes) => {
    await expect(
      fixture(bytes).client.getFileSnapshot('safe/repo', 'a.ts', 'a'.repeat(40)),
    ).rejects.toThrow();
  },
);
it('does not treat a directory as file evidence', async () => {
  const { client, request } = fixture();
  request.mockResolvedValue({ data: [] });
  expect(await client.getFileSnapshot('safe/repo', 'src', 'a'.repeat(40))).toBeNull();
});
it('sends the exact commit, preserves path case and propagates abort without HTTP calls', async () => {
  const client = new GithubClient({ accessToken: 'synthetic-only' });
  const octokit = Reflect.get(client, 'octokit');
  const content = vi.spyOn(octokit.repos, 'getContent').mockResolvedValue({
    data: { type: 'file', size: 1, encoding: 'base64', content: 'eA==', sha: 'b'.repeat(40) },
  });
  const abort = new AbortController();
  await client.getFileSnapshot('safe/repo', 'Src/File.ts', 'a'.repeat(40), abort.signal);
  expect(content).toHaveBeenCalledWith({
    owner: 'safe',
    repo: 'repo',
    path: 'Src/File.ts',
    ref: 'a'.repeat(40),
    request: { signal: abort.signal, timeout: 15000 },
  });
  content.mockClear();
  abort.abort();
  await expect(
    client.getFileSnapshot('safe/repo', 'Src/File.ts', 'a'.repeat(40), abort.signal),
  ).rejects.toThrow();
  expect(content).not.toHaveBeenCalled();
});
