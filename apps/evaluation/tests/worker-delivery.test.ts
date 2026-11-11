import { onTestFinished, expect, test, vi } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import {
  jobs,
  deletedJobs,
  diagnosticChecks,
  deliveryAnomalies,
  dlqReceipts,
  jobOutbox,
} from '@korekaite/database';
import worker, { createEvaluationWorker } from '../src/worker';
import diagnostic from '../src/worker.local';
import {
  acquireExecution,
  completeExecution,
  renewExecution,
  recoverExpiredExecution,
} from '../src/server/repositories/job-execution';
import type { JobNotification } from '@korekaite/api-contracts/messages';

function environment() {
  const fixture = createTestDatabase();
  onTestFinished(() => fixture.close());
  const queue = () => ({
    send: vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } })),
    sendBatch: vi.fn(),
    metrics: vi.fn(),
  });
  const env = {
    APP_ENV: 'development',
    DB: fixture.binding,
    EVALUATION_QUEUE_NAME: 'eval',
    EVALUATION_DLQ_NAME: 'eval-dlq',
    DIAGNOSTIC_QUEUE_NAME: 'diag',
    DIAGNOSTIC_DLQ_NAME: 'diag-dlq',
    EVALUATION_QUEUE: queue(),
    EVALUATION_DLQ: queue(),
    DIAGNOSTIC_QUEUE: queue(),
    DIAGNOSTIC_DLQ: queue(),
    CHECK_OBJECT: { getByName: vi.fn() },
  };
  return { env, db: fixture.db, sqlite: fixture.sqlite };
}
function batch(
  queue: string,
  jobId: string,
  body: { schemaVersion?: number; jobId?: string } | null = { schemaVersion: 1, jobId },
  id = crypto.randomUUID(),
) {
  const message = {
    id,
    body: body as JobNotification,
    ack: vi.fn(),
    retry: vi.fn(),
    attempts: 1,
  };
  const delivery = {
    queue,
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  };
  return delivery as typeof delivery & Parameters<typeof diagnostic.queue>[0];
}
async function job(
  db: ReturnType<typeof createTestDatabase>['db'],
  purpose: 'evaluation' | 'diagnostics',
  extra: Partial<typeof jobs.$inferInsert> = {},
) {
  const jobId = crypto.randomUUID();
  await db.insert(jobs).values({
    jobId,
    purpose,
    actorId: 'actor',
    status: 'pending',
    acceptedAt: 0,
    updatedAt: 0,
    ...extra,
  });
  return jobId;
}

test('不明なキューと不正な設定からの配送は30秒後に再試行する', async () => {
  const { env } = environment();
  for (const settings of [
    { EVALUATION_QUEUE_NAME: '' },
    { EVALUATION_DLQ_NAME: '' },
    { EVALUATION_DLQ_NAME: 'eval' },
    {},
  ]) {
    const delivery = batch('other', '');
    await worker.queue(delivery, { ...env, ...settings });
    expect(delivery.messages[0].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 30 });
    expect(delivery.messages[0].ack).not.toHaveBeenCalled();
  }
});

test('異常な配送を理由別に隔離し、同一メッセージの再受信は記録を更新する', async () => {
  const { env, db } = environment();
  const deleted = crypto.randomUUID();
  await db.insert(deletedJobs).values({ jobId: deleted, deletedAt: 0 });
  const mismatch = await job(db, 'diagnostics');
  for (const [body, code] of [
    [{ schemaVersion: 2, jobId: deleted }, 'UNSUPPORTED_SCHEMA_VERSION'],
    [{}, 'INVALID_NOTIFICATION'],
    [{ schemaVersion: 1, jobId: deleted }, 'JOB_DELETED'],
    [{ schemaVersion: 1, jobId: crypto.randomUUID() }, 'JOB_NOT_FOUND'],
    [{ schemaVersion: 1, jobId: mismatch }, 'JOB_PURPOSE_MISMATCH'],
  ] as const) {
    const delivery = batch('eval', '', body);
    await worker.queue(delivery, env);
    await worker.queue(delivery, env);
    expect(delivery.messages[0].ack).toHaveBeenCalledTimes(2);
    expect(await db.select().from(deliveryAnomalies)).toContainEqual(
      expect.objectContaining({ messageId: delivery.messages[0].id, code }),
    );
  }
});

test('正式評価の失敗をDLQへ送り、DLQ受領後は再送しない', async () => {
  const { env, db } = environment();
  const id = await job(db, 'evaluation');
  const delivery = batch('eval', id);
  await diagnostic.queue(delivery, env);
  expect(delivery.messages[0].ack).toHaveBeenCalledOnce();
  expect(env.EVALUATION_DLQ.send).toHaveBeenCalledOnce();
  const dlq = batch('eval-dlq', id);
  await diagnostic.queue(dlq, env);
  expect(dlq.messages[0].ack).toHaveBeenCalledOnce();
  expect(await db.select().from(dlqReceipts)).toMatchObject([
    { jobId: id, observedStatus: 'failed' },
  ]);
  await worker.scheduled({}, env);
  expect(env.EVALUATION_DLQ.send).toHaveBeenCalledOnce();
});

test('診断の完了とDLQの受領をジョブ状態と共に保存する', async () => {
  const { env, db } = environment();
  const id = await job(db, 'diagnostics');
  await db.insert(diagnosticChecks).values({
    jobId: id,
    scenario: 'success',
    doPersistence: 'passed',
    dlqReceipt: 'pending',
    consumerCompletion: 'pending',
  });
  await diagnostic.queue(batch('diag', id), env);
  await diagnostic.queue(batch('diag-dlq', id), env);
  expect(await db.select().from(diagnosticChecks)).toMatchObject([
    { jobId: id, consumerCompletion: 'passed', dlqReceipt: 'passed' },
  ]);
});

test('DLQから待機中ジョブを再配送し、回復経路がない実行中ジョブは再試行する', async () => {
  const { env, db } = environment();
  const id = await job(db, 'evaluation');
  const delivery = batch('eval-dlq', id);
  await worker.queue(delivery, env);
  expect(delivery.messages[0].ack).toHaveBeenCalledOnce();
  expect(env.EVALUATION_QUEUE.send).toHaveBeenCalledOnce();
  const broken = await job(db, 'evaluation', { status: 'running' });
  const stalled = batch('eval-dlq', broken);
  await worker.queue(stalled, env);
  expect(stalled.messages[0].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 30 });
});

test('実行権を更新し、同じ利用者の後続ジョブを延期して期限切れの試行だけを回復する', async () => {
  const { env, db } = environment();
  const id = await job(db, 'evaluation');
  const lease = await acquireExecution(db, id, 'evaluation', 'owner', 0);
  if (!lease) {
    throw new Error('実行権がありません。');
  }
  expect(await renewExecution(db, lease, 500)).toBe(true);
  expect(await renewExecution(db, { ...lease, ownerToken: 'other' }, 500)).toBe(false);
  const active = createEvaluationWorker({ now: () => 500 });
  for (const target of [id, await job(db, 'evaluation')]) {
    const delivery = batch('eval', target);
    await active.queue(delivery, env);
    expect(delivery.messages[0].ack).toHaveBeenCalledOnce();
  }
  expect(await db.select().from(jobOutbox)).toMatchObject([{ operation: 'notify' }]);
  expect(await recoverExpiredExecution(db, id, 'evaluation', 'early', 500)).toBe(false);
  expect(await recoverExpiredExecution(db, id, 'evaluation', 'late', lease.deadline + 100000)).toBe(
    true,
  );
});

test('診断の再試行と期限切れの初期化を回復し、目的別のQueueへ配送する', async () => {
  const { env, db } = environment();
  const id = await job(db, 'diagnostics', { actorId: 'local-developer' });
  await db.insert(diagnosticChecks).values({
    jobId: id,
    scenario: 'retry_then_success',
    doPersistence: 'passed',
    dlqReceipt: 'pending',
    consumerCompletion: 'pending',
  });
  await db.insert(jobOutbox).values({
    id: crypto.randomUUID(),
    jobId: id,
    purpose: 'diagnostics',
    operation: 'initialize_do',
    generation: 0,
    scheduledAt: 0,
  });
  const initializeCheck = vi.fn(async () => ({ jobId: id, firstReceivedAt: '0' }));
  env.CHECK_OBJECT.getByName.mockReturnValue({ initializeCheck });
  await diagnostic.scheduled({} as Parameters<typeof diagnostic.scheduled>[0], env);
  expect(initializeCheck).toHaveBeenCalledExactlyOnceWith(id);
  await diagnostic.queue(batch('diag', id), env);
  expect(env.DIAGNOSTIC_QUEUE.send).toHaveBeenCalledOnce();
  const broken = await job(db, 'diagnostics', { status: 'running' });
  const stalled = batch('diag-dlq', broken);
  await diagnostic.queue(stalled, env);
  expect(stalled.messages[0].retry).toHaveBeenCalledOnce();
  const invalid = batch('diag', '', null);
  await diagnostic.queue(invalid, env);
  expect(invalid.messages[0].ack).toHaveBeenCalledOnce();
  await diagnostic.queue(batch('diag', crypto.randomUUID()), env);
});

test('保存の競合で結果を残せない配送はackせず再試行する', async () => {
  const { env, db } = environment();
  const id = await job(db, 'evaluation', { status: 'running' });
  const delivery = batch('eval', id);
  await worker.queue(delivery, env);
  expect(delivery.messages[0].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 30 });
});

test('配送記録へ書き込めない場合はackせず再試行する', async () => {
  const { env, sqlite } = environment();
  sqlite.exec('DROP TABLE delivery_anomalies');
  const delivery = batch('eval', crypto.randomUUID());
  await worker.queue(delivery, env);
  expect(delivery.messages[0].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 30 });
  expect(delivery.messages[0].ack).not.toHaveBeenCalled();
});

test('正式ジョブの実行権があれば診断用の副作用を伴わず完了できる', async () => {
  const { db } = environment();
  const id = await job(db, 'evaluation');
  const lease = await acquireExecution(db, id, 'evaluation', 'owner', 0);
  if (!lease) {
    throw new Error('実行権がありません。');
  }
  expect(await completeExecution(db, lease, { summary: '完了' }, 100)).toBe(true);
  expect(await db.select().from(jobs)).toMatchObject([{ jobId: id, status: 'completed' }]);
});
