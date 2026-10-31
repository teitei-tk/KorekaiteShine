import { expect, test } from 'vitest';
import { listInterviews } from '../src/server/interviews.ts';
import { validateBadRequest } from '../generated/validators.mjs';

test('面接一覧を新しい順に取得し、limitで件数を制限できる', async () => {
  const response = listInterviews(new Request('http://localhost/api/interviews?limit=1'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    items: [
      {
        id: 'interview-002',
        theme: '評価処理をQueueへ分離した判断',
        startedAt: '2026-10-30T01:00:00Z',
        materialKind: 'code',
        durationSeconds: 900,
        evaluationStatus: 'waiting',
      },
    ],
  });
});

test('契約外のlimitを400で拒否する', () => {
  for (const limit of ['0', '21', '-1', '1.5', 'abc', '', '1&limit=2']) {
    const response = listInterviews(new Request(`http://localhost/api/interviews?limit=${limit}`));
    expect(response.status, `limit=${limit}`).toBe(400);
  }
});

test('400応答の本文がTypeSpecから生成した契約に一致する', async () => {
  const response = listInterviews(new Request('http://localhost/api/interviews?limit=0'));
  expect(validateBadRequest(await response.json())).toBe(true);
});

test('limitの指数・基数・小数・空白付き表記を数値化前に拒否する', async () => {
  for (const limit of ['1e1', '0x10', '0b10', '0o10', '1.0', ' 1', '1 ', '+1']) {
    const response = listInterviews(
      new Request(`http://localhost/api/interviews?limit=${encodeURIComponent(limit)}`),
    );
    expect(response.status, `limit=${limit}`).toBe(400);
    expect(validateBadRequest(await response.json())).toBe(true);
  }
});
