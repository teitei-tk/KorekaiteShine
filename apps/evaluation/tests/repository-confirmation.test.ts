import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, expect, test, vi } from 'vitest';
import { createPrimaryDb } from '@korekaite/database/connection';
import { acquireExecution } from '../src/server/repositories/job-execution';
import {
  requireDiagnosticInitialization,
  confirmDiagnosticInitialization,
} from '../../interview/src/server/repositories/check-outbox';

vi.mock('@korekaite/database/connection', () => ({ createPrimaryDb: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function database() {
  const query = new (class extends Promise<never[]> {
    select = vi.fn();
    from = vi.fn();
    where = vi.fn();
    innerJoin = vi.fn();
    limit = vi.fn();
    insert = vi.fn();
    update = vi.fn();
    set = vi.fn();
    onConflictDoNothing = vi.fn();
    returning = vi.fn();
    batch = vi.fn(async () => [[], [], [{ attemptNumber: 1 }]]);
  })((resolve) => resolve([]));
  for (const method of [
    query.select,
    query.from,
    query.where,
    query.innerJoin,
    query.limit,
    query.insert,
    query.update,
    query.set,
    query.onConflictDoNothing,
    query.returning,
  ]) {
    method.mockReturnValue(query);
  }
  return query;
}

test('実行権取得の保存後に所有ジョブを確認できなければ実行権を返さない', async () => {
  const db = database();
  expect(
    await acquireExecution(
      db as object as Parameters<typeof acquireExecution>[0],
      'job',
      'evaluation',
      'owner',
      0,
    ),
  ).toBeNull();
  expect(db.batch).toHaveBeenCalledTimes(1);
  expect(db.select).toHaveBeenLastCalledWith({ generation: expect.anything() });
});

test('診断初期化の対象がなければ保存を開始しない', async () => {
  const db = database();
  vi.mocked(createPrimaryDb).mockReturnValue(db as object as ReturnType<typeof createPrimaryDb>);
  await expect(requireDiagnosticInitialization({} as D1Database, 'job')).rejects.toThrow(
    '診断の初期化対象を確認できません。',
  );
  expect(db.batch).not.toHaveBeenCalled();
});

test('D1の初期化更新後に観測結果がなければ確定済みとして扱わない', async () => {
  const db = database();
  vi.mocked(createPrimaryDb).mockReturnValue(db as object as ReturnType<typeof createPrimaryDb>);
  await expect(confirmDiagnosticInitialization({} as D1Database, 'job', 0)).rejects.toThrow(
    'DO保存の観測結果を確定できません。',
  );
  expect(db.batch).toHaveBeenCalledTimes(1);
});
