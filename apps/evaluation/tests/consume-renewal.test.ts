import { afterEach, expect, test, vi } from 'vitest';
import { consumeJob, type EvaluationDependencies } from '../src/application/consume-job';
import {
  acquireExecution,
  completeExecution,
  renewExecution,
  isTerminalJob,
  hasActiveExecution,
  deferForBusySlot,
} from '../src/server/repositories/job-execution';
import type { EvaluationResult } from '../src/domain/evaluation-result';

vi.mock('../src/application/classify-delivery', () => ({
  classifyDelivery: async () => ({ kind: 'job', job: { purpose: 'evaluation' } }),
}));
vi.mock('../src/server/repositories/delivery-anomalies', () => ({
  refreshRecordedAnomaly: async () => false,
  recordDeliveryAnomaly: vi.fn(),
}));
vi.mock('../src/server/repositories/job-execution', () => ({
  acquireExecution: vi.fn(),
  completeExecution: vi.fn(),
  renewExecution: vi.fn(),
  isTerminalJob: vi.fn(),
  hasActiveExecution: vi.fn(),
  deferForBusySlot: vi.fn(),
  failExecution: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

test('評価待機中の実行権更新をD1へ委譲し、保存後にackして更新を停止する', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const jobId = '00000000-0000-4000-8000-000000000001';
  const lease = { jobId, ownerToken: 'owner', generation: 1, attemptNumber: 1, deadline: 180_000 };
  vi.mocked(acquireExecution).mockResolvedValue(lease);
  vi.mocked(renewExecution).mockResolvedValue(true);
  vi.mocked(completeExecution).mockResolvedValue(true);
  let finish!: (result: EvaluationResult) => void;
  const evaluate = vi.fn(
    () =>
      new Promise<EvaluationResult>((resolve) => {
        finish = resolve;
      }),
  );
  const db = {} as EvaluationDependencies['db'];
  const effects = { completed: vi.fn(() => []) };
  const result = consumeJob(
    { schemaVersion: 1, jobId },
    {
      queueName: 'evaluation',
      messageId: 'message',
      expectedPurpose: 'evaluation',
      kind: 'normal',
    },
    { db, now: () => vi.getMockedSystemTime()!.getTime(), newId: () => 'owner', evaluate, effects },
  );
  await vi.advanceTimersByTimeAsync(30_000);
  expect(renewExecution).toHaveBeenCalledExactlyOnceWith(db, lease, 30_000);
  finish({ ok: true, value: { summary: 'result' } });
  expect(await result).toEqual({ action: 'ack' });
  expect(completeExecution).toHaveBeenCalledExactlyOnceWith(
    db,
    lease,
    { summary: 'result' },
    30_000,
    effects,
  );
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('実行権が取れず終端・実行中・枠待ちのいずれでもなければ配送を再試行する', async () => {
  vi.mocked(acquireExecution).mockResolvedValue(null);
  vi.mocked(isTerminalJob).mockResolvedValue(false);
  vi.mocked(hasActiveExecution).mockResolvedValue(false);
  vi.mocked(deferForBusySlot).mockResolvedValue(false);
  const evaluate = vi.fn();
  expect(
    await consumeJob(
      { schemaVersion: 1, jobId: '00000000-0000-4000-8000-000000000001' },
      {
        queueName: 'evaluation',
        messageId: 'message',
        expectedPurpose: 'evaluation',
        kind: 'normal',
      },
      { db: {} as EvaluationDependencies['db'], now: () => 0, newId: () => 'owner', evaluate },
    ),
  ).toEqual({ action: 'retry', delaySeconds: 30 });
  expect(deferForBusySlot).toHaveBeenCalledTimes(1);
  expect(evaluate).not.toHaveBeenCalled();
});

test('取得した実行権の期限に既に達していた場合は評価せず配送を再試行する', async () => {
  const jobId = '00000000-0000-4000-8000-000000000001';
  vi.mocked(acquireExecution).mockResolvedValue({
    jobId,
    ownerToken: 'owner',
    generation: 1,
    attemptNumber: 1,
    deadline: 0,
  });
  const evaluate = vi.fn();
  expect(
    await consumeJob(
      { schemaVersion: 1, jobId },
      {
        queueName: 'evaluation',
        messageId: 'message',
        expectedPurpose: 'evaluation',
        kind: 'normal',
      },
      { db: {} as EvaluationDependencies['db'], now: () => 0, newId: () => 'owner', evaluate },
    ),
  ).toEqual({ action: 'retry', delaySeconds: 30 });
  expect(evaluate).not.toHaveBeenCalled();
  expect(completeExecution).not.toHaveBeenCalled();
  expect(renewExecution).not.toHaveBeenCalled();
});
