import { expect, test, vi } from 'vitest';
import { createDiagnosticRun, getDiagnosticStatus } from '../src/diagnostics/client';

test('ジョブのfailedをHTTP失敗と区別し、DLQ未受信の状態を保持する', async () => {
  const jobId = 'de82593e-01ef-4871-80e2-a8b8ba46ae95';
  const status = {
    jobId,
    scenario: 'exhaust_retries',
    status: 'failed',
    attemptCount: 4,
    acceptedAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:08:00.000Z',
    finishedAt: '2026-11-03T00:08:00.000Z',
    nextAttemptAt: null,
    lastErrorCode: 'AI_TEMPORARY',
    checks: { doPersistence: 'passed', consumerCompletion: 'not_expected', dlqReceipt: 'pending' },
  };
  let requestedUrl = '';
  const result = await getDiagnosticStatus(jobId, {
    baseUrl: 'http://localhost',
    fetcher: async (input) => {
      requestedUrl = new Request(input).url;
      return Response.json(status);
    },
  });
  expect(requestedUrl).toBe(`http://localhost/api/diagnostics/check-jobs/${jobId}`);
  expect(result).toEqual(status);
});

test('202応答が失われても同じ冪等キーと入力で再送し、別ジョブを作らない', async () => {
  const key = '7e318b72-f255-4f17-845b-714d487ae621';
  const accepted = {
    jobId: 'de82593e-01ef-4871-80e2-a8b8ba46ae95',
    scenario: 'success',
    acceptedAt: '2026-11-03T00:00:00.000Z',
  };
  const keys: (string | null)[] = [];
  const bodies: object[] = [];
  const acceptedKeys = new Set<string>();
  let requests = 0;
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const request = new Request(input, init);
    const idempotencyKey = request.headers.get('Idempotency-Key');
    keys.push(idempotencyKey);
    bodies.push(await request.json());
    if (idempotencyKey) acceptedKeys.add(idempotencyKey);
    if (++requests === 1) throw new TypeError('受付後に応答が失われました。');
    return Response.json(accepted, { status: 202 });
  });
  const newId = vi.fn(() => key);
  const run = createDiagnosticRun('success', { baseUrl: 'http://localhost', fetcher, newId });
  await expect(run.start()).rejects.toThrow();
  await expect(run.start()).resolves.toEqual(accepted);
  expect(keys).toEqual([key, key]);
  expect(bodies).toEqual([{ scenario: 'success' }, { scenario: 'success' }]);
  expect(acceptedKeys.size).toBe(1);
  expect(newId).toHaveBeenCalledTimes(1);
});

test('契約外の状態応答を結果として返さない', async () => {
  await expect(
    getDiagnosticStatus('de82593e-01ef-4871-80e2-a8b8ba46ae95', {
      baseUrl: 'http://localhost',
      fetcher: async () => Response.json({ status: 'completed', checks: { dlqReceipt: 'passed' } }),
    }),
  ).rejects.toThrow('契約');
});

test('入力エラーを説明文ではなくcodeと型付きdetailsで扱う', async () => {
  const detail = {
    location: 'body',
    path: '/scenario',
    code: 'INVALID_VALUE',
    message: '説明は変更可能です。',
  };
  const run = createDiagnosticRun('success', {
    baseUrl: 'http://localhost',
    fetcher: async () =>
      Response.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: '任意の説明文',
            requestId: '7e318b72-f255-4f17-845b-714d487ae621',
            details: [detail],
          },
        },
        { status: 400 },
      ),
  });
  await expect(run.start()).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
    status: 400,
    details: [detail],
    requestId: '7e318b72-f255-4f17-845b-714d487ae621',
  });
});
