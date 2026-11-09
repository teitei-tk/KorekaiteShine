import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, expect, test, vi } from 'vitest';
import { consumeJob } from '../src/application/consume-job';
import { consumeDiagnostic } from '../src/diagnostics/consume';

const boundary = vi.hoisted(() => ({ select: vi.fn(), where: vi.fn() }));
vi.mock('@korekaite/database/connection', () => ({
  createPrimaryDb: () => ({ select: boundary.select }),
}));
vi.mock('../src/application/consume-job', () => ({ consumeJob: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const jobId = '00000000-0000-4000-8000-000000000001';
async function evaluator() {
  await consumeDiagnostic(
    { schemaVersion: 1, jobId },
    {
      queueName: 'diagnostics',
      messageId: 'message',
      expectedPurpose: 'diagnostics',
      kind: 'normal',
    },
    {} as D1Database,
  );
  return vi.mocked(consumeJob).mock.calls[0][2].evaluate;
}

test('診断評価の開始前に中断済みならDBへ問い合わせない', async () => {
  const evaluate = await evaluator();
  const controller = new AbortController();
  controller.abort();
  await expect(evaluate(jobId, 1, controller.signal)).rejects.toThrow('評価は中止されました。');
  expect(boundary.select).not.toHaveBeenCalled();
});

test('診断条件が存在しない場合は成功結果を作らず失敗を返す', async () => {
  boundary.select.mockReturnValue({ from: () => ({ where: boundary.where }) });
  boundary.where.mockResolvedValue([]);
  const evaluate = await evaluator();
  await expect(evaluate(jobId, 1, new AbortController().signal)).rejects.toThrow(
    '診断条件がありません。',
  );
  expect(boundary.where).toHaveBeenCalledTimes(1);
});

test('DB応答の待機中に中断した場合も診断評価を実行しない', async () => {
  const controller = new AbortController();
  let resolveQuery!: (rows: { scenario: 'success' }[]) => void;
  boundary.select.mockReturnValue({ from: () => ({ where: boundary.where }) });
  boundary.where.mockReturnValue(
    new Promise((resolve) => {
      resolveQuery = resolve;
    }),
  );
  const evaluate = await evaluator();
  const result = evaluate(jobId, 1, controller.signal);
  expect(boundary.where).toHaveBeenCalledTimes(1);
  controller.abort();
  resolveQuery([{ scenario: 'success' }]);
  await expect(result).rejects.toThrow('評価は中止されました。');
});
