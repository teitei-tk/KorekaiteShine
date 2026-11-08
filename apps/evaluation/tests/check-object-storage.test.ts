import { afterEach, expect, test, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { CheckObject } from '../../interview/src/diagnostics/check-object';
import {
  confirmDiagnosticInitialization,
  pendingCheckNotification,
  markCheckNotificationSent,
} from '../../interview/src/server/repositories/check-outbox';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      protected ctx: object,
      protected env: object,
    ) {}
  },
}));
vi.mock('../../interview/src/server/repositories/check-outbox', () => ({
  requireDiagnosticInitialization: vi.fn(async () => {}),
  confirmDiagnosticInitialization: vi.fn(async () => {}),
  pendingCheckNotification: vi.fn(),
  markCheckNotificationSent: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const jobId = '00000000-0000-4000-8000-000000000001';
function fixture(persisted: { jobId: string; firstReceivedAt: string } | undefined) {
  vi.spyOn(Temporal.Now, 'instant').mockReturnValue(Temporal.Instant.from('2026-11-07T00:00:00Z'));
  const put = vi.fn(async () => {});
  const send = vi.fn();
  const object = new CheckObject(
    {
      storage: {
        transaction: async (
          callback: (transaction: {
            get(): Promise<undefined>;
            put: typeof put;
          }) => Promise<object>,
        ) =>
          callback({
            get: async () => undefined,
            put,
          }),
        get: async () => persisted,
      },
    } as object as ConstructorParameters<typeof CheckObject>[0],
    {
      APP_ENV: 'test',
      DIAGNOSTIC_QUEUE: { send },
    } as object as ConstructorParameters<typeof CheckObject>[1],
  );
  return { object, put, send };
}

test('DOの保存後読取りで値が消えていた場合はD1確定とQueue送信をしない', async () => {
  const { object, put, send } = fixture(undefined);
  await expect(object.initializeCheck(jobId)).rejects.toThrow('DOの保存結果を確認できません。');
  expect(put).toHaveBeenCalledTimes(1);
  expect(confirmDiagnosticInitialization).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('DOの保存後読取りでジョブIDが異なる場合はD1を確定しない', async () => {
  const { object, send } = fixture({ jobId: 'other', firstReceivedAt: '2026-11-07T00:00:00.000Z' });
  await expect(object.initializeCheck(jobId)).rejects.toThrow('DOの保存結果を確認できません。');
  expect(confirmDiagnosticInitialization).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('DOの保存後読取りで受付時刻が異なる場合はD1を確定しない', async () => {
  const { object, send } = fixture({ jobId, firstReceivedAt: '2026-11-07T00:00:01.000Z' });
  await expect(object.initializeCheck(jobId)).rejects.toThrow('DOの保存結果を確認できません。');
  expect(confirmDiagnosticInitialization).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('DBから契約違反の通知が返った場合は送信も送信済み記録もしない', async () => {
  const { object, send } = fixture({ jobId, firstReceivedAt: '2026-11-07T00:00:00.000Z' });
  vi.mocked(pendingCheckNotification).mockResolvedValue({ id: 'outbox', jobId: 'invalid' });
  await expect(object.initializeCheck(jobId)).rejects.toThrow('通知契約を満たしていません。');
  expect(confirmDiagnosticInitialization).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(markCheckNotificationSent).not.toHaveBeenCalled();
});
