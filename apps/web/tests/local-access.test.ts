import { expect, test } from 'vitest';
import { createLocalAccess } from '../src/server/local-access';

const token = 'a'.repeat(64);
const url = 'http://127.0.0.1:4327/api/interviews';
const cookie = `korekaite-local-session=${token}`;
test('ローカル本人のcookie・操作トークン・Originを確認し、外部と本番を拒否する', () => {
  const access = createLocalAccess('development', token);
  const request = (headers: Record<string, string> = {}) =>
    new Request(url, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://127.0.0.1:4327',
        'X-Interview-Token': token,
        ...headers,
      },
    });
  expect(access.actor(request(), 'write')).toBe('local-developer');
  expect(access.actor(request({ Origin: 'https://other.example' }), 'write')).toBeNull();
  expect(access.actor(request({ Host: 'other.example' }), 'write')).toBeNull();
  expect(access.actor(request({ 'X-Interview-Token': 'wrong' }), 'write')).toBeNull();
  expect(access.actor(request({ Cookie: '' }), 'write')).toBeNull();
  expect(access.actor(request({ 'Sec-Fetch-Site': 'cross-site' }), 'write')).toBeNull();
  expect(createLocalAccess('production', token).actor(request(), 'write')).toBeNull();
  expect(
    access.actor(
      new Request('http://other.example/api/interviews', { headers: { Cookie: cookie } }),
      'read',
    ),
  ).toBeNull();
});

test('読取とWebSocketにもcookieを要求し、WebSocketはOriginが必須', () => {
  const access = createLocalAccess('test', token);
  expect(access.canBootstrap(new Request('http://localhost:4327/api/local-session'))).toBe(true);
  expect(
    access.canBootstrap(new Request(url, { headers: { Origin: 'http://localhost:9999' } })),
  ).toBe(false);
  expect(access.actor(new Request(url, { headers: { Cookie: cookie } }), 'read')).toBe(
    'local-developer',
  );
  expect(access.actor(new Request(url, { headers: { Cookie: cookie } }), 'websocket')).toBeNull();
  expect(
    access.actor(
      new Request(url, {
        headers: { Cookie: cookie, Origin: 'http://127.0.0.1:4327', Upgrade: 'websocket' },
      }),
      'websocket',
    ),
  ).toBe('local-developer');
});
