import { expect, test, vi } from 'vitest';
import { jobs, diagnosticChecks, jobOutbox } from '@korekaite/database';
import { createTestDatabase } from '../../../packages/database/testing/sqlite';
import { CheckObject, type CheckInitialized } from '../src/diagnostics/check-object';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      protected ctx: object,
      protected env: object,
    ) {}
  },
}));

test('診断DOの再初期化では最初の受信時刻と送信済み通知を再利用する', async () => {
  const database = createTestDatabase();
  const send = vi.fn(async () => {});
  const env = { DB: database.binding, APP_ENV: 'production', DIAGNOSTIC_QUEUE: { send } };
  const data = new Map<string, CheckInitialized>();
  const values = {
    get: (key: string) => data.get(key),
    put: (key: string, value: CheckInitialized) => data.set(key, value),
  };
  const storage = {
    ...values,
    transaction: (work: (tx: typeof values) => Promise<CheckInitialized>) => work(values),
  };
  const object = new CheckObject(
    { storage } as object as ConstructorParameters<typeof CheckObject>[0],
    env as object as ConstructorParameters<typeof CheckObject>[1],
  );
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  try {
    await expect(object.initializeCheck(first)).rejects.toThrow('利用できない環境');
    env.APP_ENV = 'development';
    await expect(object.initializeCheck('invalid')).rejects.toThrow('不正');
    for (const jobId of [first, second]) {
      await database.db.insert(jobs).values({
        jobId,
        actorId: 'local-developer',
        purpose: 'diagnostics',
        status: 'pending',
        acceptedAt: 1,
        updatedAt: 1,
      });
      await database.db.insert(diagnosticChecks).values({
        jobId,
        scenario: 'success',
        doPersistence: 'pending',
        consumerCompletion: 'pending',
        dlqReceipt: 'not_expected',
      });
      await database.db.insert(jobOutbox).values({
        id: crypto.randomUUID(),
        jobId,
        purpose: 'diagnostics',
        operation: 'initialize_do',
        scheduledAt: 1,
      });
    }
    const saved = await object.initializeCheck(first);
    expect(saved.jobId).toBe(first);
    env.APP_ENV = 'test';
    expect(await object.initializeCheck(first)).toEqual(saved);
    expect(send).toHaveBeenCalledExactlyOnceWith({ schemaVersion: 1, jobId: first });
    await expect(object.initializeCheck(second)).rejects.toThrow('対応が一致');
  } finally {
    database.close();
  }
});
