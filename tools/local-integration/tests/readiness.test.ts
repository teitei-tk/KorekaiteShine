import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { confirmHttpReady } from '../src/readiness.ts';

test('起動確認のHTTP本文が終わらない場合も期限内に失敗し接続を閉じる', async () => {
  let disconnected = false;
  const server = createServer((_request, response) => {
    response.on('close', () => {
      disconnected = true;
    });
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.write('<html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('TCPポートがありません。');
    }
    const started = performance.now();
    await expect(confirmHttpReady(`http://127.0.0.1:${address.port}`, 100)).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2000);
    await expect.poll(() => disconnected, { timeout: 1000 }).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}, 5000);
