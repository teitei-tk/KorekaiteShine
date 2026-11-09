import { expect, test } from 'vitest';
import { createLocalAccess } from '../src/server/local-access';
import { localSessionRequest } from '../src/server/local-session';

test('ローカル画面に操作トークンとHttpOnly Cookieを返し、外部要求には発行しない', async () => {
  const token = 'a'.repeat(64);
  const access = createLocalAccess('development', token);
  const response = localSessionRequest(
    new Request('http://localhost:4327/api/local-session'),
    access,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Set-Cookie')).toBe(
    `korekaite-local-session=${token}; Path=/; HttpOnly; SameSite=Strict`,
  );
  expect(await response.json()).toEqual({ operationToken: token });
  for (const request of [
    new Request('http://localhost:4327/api/local-session', {
      headers: { Origin: 'https://external.example' },
    }),
    new Request('https://external.example/api/local-session'),
    new Request('http://localhost:4327/api/local-session', { method: 'POST' }),
  ]) {
    const denied = localSessionRequest(request, access);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('Set-Cookie')).toBeNull();
    expect(denied.headers.get('Cache-Control')).toBe('no-store');
    expect(await denied.text()).not.toContain(token);
  }
  expect(
    localSessionRequest(
      new Request('http://localhost/api/local-session'),
      createLocalAccess('production', token),
    ).status,
  ).toBe(403);
});
