import type { D1Database } from '@cloudflare/workers-types';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, expect, test, vi } from 'vitest';
import { recoverExecutions } from '../src/application/recover-executions';
import { recoverInitializations } from '../src/application/recover-initialization';
import { recoverExpiredExecution } from '../src/server/repositories/job-execution';

const boundary = vi.hoisted(() => ({ orderBy: vi.fn() }));
vi.mock('@korekaite/database/connection', () => ({
  createPrimaryDb: () => {
    const query = {
      select: () => query,
      selectDistinct: () => query,
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      orderBy: boundary.orderBy,
    };
    return query;
  },
}));
vi.mock('../src/server/repositories/job-execution', () => ({ recoverExpiredExecution: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

test('実行回復に失敗したジョブを保留し、既定の時計で後続ジョブの回復を続ける', async () => {
  vi.spyOn(Temporal.Now, 'instant').mockReturnValue(
    Temporal.Instant.fromEpochMilliseconds(300_000),
  );
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  boundary.orderBy.mockResolvedValue([
    { jobId: 'failed', purpose: 'evaluation' },
    { jobId: 'next', purpose: 'diagnostics' },
  ]);
  vi.mocked(recoverExpiredExecution).mockRejectedValueOnce(new Error('private details'));
  await recoverExecutions({} as D1Database);
  expect(recoverExpiredExecution).toHaveBeenCalledTimes(2);
  expect(recoverExpiredExecution).toHaveBeenLastCalledWith(
    expect.anything(),
    'next',
    'diagnostics',
    expect.any(String),
    300_000,
  );
  expect(log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ event: 'execution_recovery_deferred', jobId: 'failed' }),
  );
});

test('初期化に失敗しても後続ジョブを初期化し、失敗の内部情報は記録しない', async () => {
  const clock = vi
    .spyOn(Temporal.Now, 'instant')
    .mockReturnValue(Temporal.Instant.fromEpochMilliseconds(300_000));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  boundary.orderBy.mockResolvedValue([{ jobId: 'failed' }, { jobId: 'next' }]);
  const initialize = vi.fn(async () => {}).mockRejectedValueOnce(new Error('private details'));
  await recoverInitializations({} as D1Database, initialize);
  expect(clock).toHaveBeenCalledTimes(1);
  expect(initialize.mock.calls).toEqual([['failed'], ['next']]);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ event: 'diagnostic_initialization_deferred', jobId: 'failed' }),
  );
});
