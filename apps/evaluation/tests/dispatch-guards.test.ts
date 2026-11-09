import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, expect, test, vi } from 'vitest';
import { dispatchNotifications } from '../src/application/dispatch-notifications';
import { pendingNotifications, markNotificationSent } from '../src/server/repositories/outbox';

vi.mock('@korekaite/database/connection', () => ({ createPrimaryDb: vi.fn(() => ({})) }));
vi.mock('../src/server/repositories/outbox', () => ({
  pendingNotifications: vi.fn(),
  markNotificationSent: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const row = {
  id: 'outbox',
  jobId: '00000000-0000-4000-8000-000000000001',
  purpose: 'diagnostics' as const,
  operation: 'notify' as const,
  generation: 0,
  scheduledAt: 0,
  sentAt: null,
};
function dependencies() {
  return {
    database: {} as D1Database,
    now: vi.fn(() => 0),
    sendNotification: vi.fn(async () => {}),
  };
}

test('対象と異なる用途の通知は送信せず未送信のまま残す', async () => {
  vi.mocked(pendingNotifications).mockResolvedValue([{ notification: row, nextAttemptAt: null }]);
  const deps = dependencies();
  expect(await dispatchNotifications(deps, { expectedPurpose: 'evaluation' })).toEqual({
    outboxSent: 0,
    outboxDeferred: 0,
  });
  expect(deps.sendNotification).not.toHaveBeenCalled();
  expect(markNotificationSent).not.toHaveBeenCalled();
});

test('DO初期化のoutboxはQueueへ送信しない', async () => {
  vi.mocked(pendingNotifications).mockResolvedValue([
    { notification: { ...row, operation: 'initialize_do' }, nextAttemptAt: null },
  ]);
  const deps = dependencies();
  expect(await dispatchNotifications(deps)).toEqual({ outboxSent: 0, outboxDeferred: 0 });
  expect(deps.sendNotification).not.toHaveBeenCalled();
  expect(markNotificationSent).not.toHaveBeenCalled();
});

test('操作を指定した配送は他の操作を未送信のまま残す', async () => {
  vi.mocked(pendingNotifications).mockResolvedValue([{ notification: row, nextAttemptAt: null }]);
  const deps = dependencies();
  expect(await dispatchNotifications(deps, { operation: 'notify_dlq' })).toEqual({
    outboxSent: 0,
    outboxDeferred: 0,
  });
  expect(deps.sendNotification).not.toHaveBeenCalled();
  expect(markNotificationSent).not.toHaveBeenCalled();
});

test('契約違反の通知は保留し、後続の正常な通知は送信する', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.mocked(pendingNotifications).mockResolvedValue([
    { notification: { ...row, jobId: 'invalid' }, nextAttemptAt: null },
    { notification: row, nextAttemptAt: null },
  ]);
  const deps = dependencies();
  expect(await dispatchNotifications(deps)).toEqual({ outboxSent: 1, outboxDeferred: 1 });
  expect(deps.sendNotification).toHaveBeenCalledExactlyOnceWith(
    'diagnostics',
    'notify',
    { schemaVersion: 1, jobId: row.jobId },
    0,
  );
  expect(markNotificationSent).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ event: 'notification_delivery_deferred', jobId: 'invalid' }),
  );
  log.mockRestore();
});

test('取得後に時計が戻り遅延が上限を超えた通知は送信せず次の回復へ残す', async () => {
  vi.mocked(pendingNotifications).mockResolvedValue([
    { notification: { ...row, scheduledAt: 86_400_000 }, nextAttemptAt: null },
  ]);
  const deps = dependencies();
  deps.now.mockReturnValueOnce(0).mockReturnValue(-1);
  expect(await dispatchNotifications(deps, { includeFuture: true })).toEqual({
    outboxSent: 0,
    outboxDeferred: 0,
  });
  expect(pendingNotifications).toHaveBeenCalledWith(expect.anything(), 86_400_000, undefined);
  expect(deps.sendNotification).not.toHaveBeenCalled();
  expect(markNotificationSent).not.toHaveBeenCalled();
});
