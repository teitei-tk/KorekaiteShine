import { expect, test } from 'vitest';
import { readJsonBody } from '../src/server/json-body';

test('欠落本文と読み取り前に切断したストリームを拒否する', async () => {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  const url = 'http://localhost/api/interviews';
  expect(await readJsonBody(new Request(url, init), 1024)).toEqual({
    ok: false,
    code: 'INVALID_REQUEST',
  });
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error('disconnected'));
    },
  });
  expect(
    await readJsonBody(new Request(url, { ...init, body, duplex: 'half' } as RequestInit), 1024),
  ).toEqual({ ok: false, code: 'INVALID_REQUEST' });
});
