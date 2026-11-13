import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { confirmHttpReady } from '../src/readiness.ts';

test('起動確認のHTTP本文が終わらない場合も期限内に失敗し接続を閉じる', async () => {
  const disconnectedState = { disconnected: false };
  const server = createServer((_request, response) => {
    response.on('close', () => {
      disconnectedState.disconnected = true;
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
    await expect.poll(() => disconnectedState.disconnected, { timeout: 1000 }).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}, 5000);

test('起動確認のHTTP応答が失敗状態なら本文の完了後も準備完了にしない', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end('unavailable');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('TCPポートがありません。');
    }
    await expect(confirmHttpReady(`http://127.0.0.1:${address.port}`, 1000)).rejects.toThrow(
      'Web起動確認が503で失敗しました。',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('呼び出し元が起動を取り消した場合はHTTP確認を中止する', async () => {
  const reason = new Error('起動が取り消されました。');
  await expect(
    confirmHttpReady('data:text/plain,ready', 1000, AbortSignal.abort(reason)),
  ).rejects.toBe(reason);
});
