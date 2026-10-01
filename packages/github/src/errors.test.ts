import { expect, it } from 'vitest';
import { RequestError } from '@octokit/request-error';
import { classifyGithubError } from './errors';

it.each([409, 422, 500, 418])('withholds arbitrary GitHub bodies/URLs while preserving status %s', (status) => {
  const marker = 'SECRET_PROVIDER_MARKER';
  const error = new RequestError(marker, status, { request: { method: 'GET', url: `https://api.github.com/?code=${marker}`, headers: { authorization: marker } }, response: { status, url: '', headers: {}, data: { documentation_url: `https://docs.github.com/rest?key=${marker}` } } });
  const classified = classifyGithubError(error);
  expect(classified.status).toBe(status);
  expect(JSON.stringify(classified)).not.toContain(marker);
  expect(String(classified)).not.toContain(marker);
});
