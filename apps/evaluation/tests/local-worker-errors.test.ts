import { afterEach, expect, test, vi } from 'vitest';
import worker from '../src/worker.local';
import { consumeDiagnostic } from '../src/diagnostics/consume';
import { dispatchNotifications } from '../src/application/dispatch-notifications';
import { recoverJobs } from '../src/application/recover-jobs';

vi.mock('@korekaite/database/connection', () => ({ createPrimaryDb: () => ({}) }));
vi.mock('../src/server/repositories/delivery-anomalies', () => ({
  isQuarantinedDelivery: vi.fn(async () => false),
}));
vi.mock('../src/diagnostics/consume', () => ({ consumeDiagnostic: vi.fn() }));
vi.mock('../src/application/dispatch-notifications', () => ({ dispatchNotifications: vi.fn() }));
vi.mock('../src/application/recover-jobs', () => ({ recoverJobs: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function environment(appEnv = 'test') {
  return {
    APP_ENV: appEnv,
    DIAGNOSTIC_QUEUE_NAME: 'diagnostics',
    DIAGNOSTIC_DLQ_NAME: 'diagnostics-dlq',
  } as Parameters<typeof worker.queue>[1];
}
function batch(queue = 'diagnostics') {
  const message = {
    id: 'message',
    body: { schemaVersion: 1, jobId: '00000000-0000-4000-8000-000000000001' },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return { queue, messages: [message] } as object as Parameters<typeof worker.queue>[0] & {
    messages: [typeof message];
  };
}

test('本番環境では診断Queueのメッセージを処理しない', async () => {
  const messages = batch();
  await expect(worker.queue(messages, environment('production'))).rejects.toThrow(
    '診断評価を利用できない環境です。',
  );
  expect(consumeDiagnostic).not.toHaveBeenCalled();
  expect(messages.messages[0].ack).not.toHaveBeenCalled();
});

test('未知のQueueは処理もackもせず30秒後に再配送する', async () => {
  const messages = batch('unknown');
  await worker.queue(messages, environment());
  expect(consumeDiagnostic).not.toHaveBeenCalled();
  expect(messages.messages[0].ack).not.toHaveBeenCalled();
  expect(messages.messages[0].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 30 });
});

test('通知の再配送に失敗しても保存済みの処理はackし内部エラーを記録しない', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.mocked(consumeDiagnostic).mockResolvedValue({ action: 'ack' });
  vi.mocked(dispatchNotifications).mockRejectedValueOnce(new Error('private details'));
  const messages = batch();
  await worker.queue(messages, environment());
  expect(messages.messages[0].ack).toHaveBeenCalledTimes(1);
  expect(messages.messages[0].retry).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({
      event: 'notification_dispatch_deferred',
      jobId: messages.messages[0].body.jobId,
    }),
  );
});

test('本番環境ではscheduledから診断回復を開始しない', async () => {
  await expect(
    worker.scheduled({} as Parameters<typeof worker.scheduled>[0], environment('production')),
  ).rejects.toThrow('診断回復を利用できない環境です。');
  expect(recoverJobs).not.toHaveBeenCalled();
});

test('scheduledで正式評価の回復通知を送る際は遅延を維持して正式Queueへ渡す', async () => {
  const env = environment();
  const createQueue = () => ({
    send: vi.fn<typeof env.EVALUATION_QUEUE.send>().mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    }),
    metrics: vi.fn<typeof env.EVALUATION_QUEUE.metrics>(),
    sendBatch: vi.fn<typeof env.EVALUATION_QUEUE.sendBatch>(),
  });
  const queue = createQueue();
  const diagnosticQueue = createQueue();
  const send = queue.send;
  const diagnosticSend = diagnosticQueue.send;
  env.EVALUATION_QUEUE = queue;
  env.DIAGNOSTIC_QUEUE = diagnosticQueue;
  const notification = { schemaVersion: 1 as const, jobId: '00000000-0000-4000-8000-000000000001' };
  vi.mocked(recoverJobs).mockImplementationOnce(async (deps) => {
    await deps.sendNotification('evaluation', 'notify', notification, 30);
    return { outboxSent: 1, outboxDeferred: 0 };
  });
  await worker.scheduled({} as Parameters<typeof worker.scheduled>[0], env);
  expect(send).toHaveBeenCalledExactlyOnceWith(notification, { delaySeconds: 30 });
  expect(diagnosticSend).not.toHaveBeenCalled();
});
