import { once } from 'node:events';
import { request } from 'node:http';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';

const listener = vi.hoisted(() => ({}));

vi.mock('node:http', async (original) => {
  const http = await original();
  return {
    ...http,
    createServer(handler) {
      const server = http.createServer(handler);
      listener.server = server;
      return {
        listen(port, host) {
          expect([port, host]).toEqual([3128, '0.0.0.0']);
          server.listen(0, '127.0.0.1');
        },
      };
    },
  };
});

beforeAll(async () => {
  await import('../../containers/registry-proxy.mjs');
  if (!listener.server.listening) {
    await once(listener.server, 'listening');
  }
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => listener.server.close());

async function proxy(path, method = 'GET', headers = {}) {
  const req = request({
    hostname: '127.0.0.1',
    port: listener.server.address().port,
    path,
    method,
    headers,
  });
  const ready = once(req, 'response');
  req.end();
  const [res] = await ready;
  const chunks = [];
  for await (const chunk of res) {
    chunks.push(chunk);
  }
  return {
    status: res.statusCode,
    type: res.headers['content-type'],
    body: Buffer.concat(chunks).toString(),
  };
}

test('GET以外とGuard外の宛先を上流への接続前に拒否する', async () => {
  const upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
  expect((await proxy('/pkg', 'POST')).status).toBe(403);
  expect((await proxy('https://example.invalid/pkg')).status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});

test('Guardの拒否・本文・Content-Typeを伝え、空の応答も完了する', async () => {
  const upstream = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'blocked' }, { status: 403 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', upstream);
  const result = await proxy('/pkg', 'GET', { accept: 'application/json' });
  expect(result).toEqual({ status: 403, type: 'application/json', body: '{"error":"blocked"}' });
  expect(upstream.mock.calls[0][0].href).toBe('https://npm.flatt.tech/pkg');
  expect(upstream.mock.calls[0][1].headers.accept).toBe('application/json');
  expect(await proxy('/empty')).toEqual({
    status: 204,
    type: 'application/octet-stream',
    body: '',
  });
});

test('Guardが指定したnpm配布元から本文を取得し、追加の転送は拒否する', async () => {
  const target = 'https://registry.npmjs.org/pkg/-/pkg.tgz';
  const upstream = vi
    .fn()
    .mockResolvedValueOnce(new Response('redirect', { status: 302, headers: { location: target } }))
    .mockResolvedValueOnce(new Response('tarball'))
    .mockResolvedValueOnce(Response.redirect(target))
    .mockResolvedValueOnce(new Response('redirect', { status: 307, headers: { location: target } }))
    .mockResolvedValueOnce(Response.redirect(target))
    .mockResolvedValueOnce(Response.redirect(target));
  vi.stubGlobal('fetch', upstream);
  expect((await proxy('/pkg.tgz')).body).toBe('tarball');
  expect(upstream.mock.calls[1][0].href).toBe(target);
  expect((await proxy('/pkg.tgz')).status).toBe(502);
  expect((await proxy('/pkg.tgz')).status).toBe(502);
});

test.each([
  'https://example.invalid/p',
  'https://user@registry.npmjs.org/p',
  'https://:pass@registry.npmjs.org/p',
])('未許可の転送先 %s を拒否する', async (target) => {
  const upstream = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 302, headers: { location: target } }));
  vi.stubGlobal('fetch', upstream);
  expect((await proxy('/pkg')).status).toBe(502);
  expect(upstream).toHaveBeenCalledTimes(1);
});

test('配信開始後に上流が切断した場合は不完全な応答を失敗させる', async () => {
  const gate = Promise.withResolvers();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array([1]));
      await gate.promise;
      controller.error(new Error('fixture'));
    },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
  const req = request({
    hostname: '127.0.0.1',
    port: listener.server.address().port,
    path: '/pkg',
  });
  const ready = once(req, 'response');
  req.end();
  const [res] = await ready;
  const failure = once(res, 'error');
  res.resume();
  gate.resolve();
  await expect(failure).resolves.toBeDefined();
});

test('依存取得前にGuardの403と拒否理由の両方を検証する', async () => {
  const upstream = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'other' }, { status: 403 }))
    .mockResolvedValueOnce(
      Response.json({ error: 'Package blocked by security policy' }, { status: 403 }),
    );
  vi.stubGlobal('fetch', upstream);
  await expect(import('../../containers/check-registry.mjs')).rejects.toThrow();
  vi.resetModules();
  await expect(import('../../containers/check-registry.mjs')).resolves.toBeDefined();
  expect(upstream.mock.calls[0][0]).toBe(
    'http://registry-proxy:3128/@panda-guard%2ftest-malicious',
  );
});
