import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { RuntimeConfig } from '@korekaite/runtime-config';
import { runDatabaseCommand, type LocalRuntime } from '../src/runtime.ts';
import { createNotificationRuntime } from './helpers/notification-runtime.ts';

const suite = createNotificationRuntime();
beforeAll(() => suite.start(), 60_000);
afterAll(() => suite.stop(), 30_000);

const now = 1_000_000;

async function seedNotification(
  config: RuntimeConfig,
  jobId: string,
  scheduledAt: number,
  nextAttemptAt: number | null = null,
) {
  await runDatabaseCommand(config, [
    'execute',
    `
 INSERT INTO jobs(job_id, actor_id, purpose, status, attempt_count, generation, accepted_at, updated_at, next_attempt_at)
 VALUES ('${jobId}', 'local-test', 'diagnostics', '${nextAttemptAt === null ? 'pending' : 'retry_wait'}', ${nextAttemptAt === null ? 0 : 1}, ${nextAttemptAt === null ? 0 : 1}, ${now}, ${now}, ${nextAttemptAt ?? 'NULL'});
 INSERT INTO job_outbox(id, job_id, purpose, operation, generation, scheduled_at)
 VALUES ('${randomUUID()}', '${jobId}', 'diagnostics', 'notify', ${nextAttemptAt === null ? 0 : 1}, ${scheduledAt});
 `,
  ]);
}
async function dispatch(runtime: LocalRuntime, failJobId?: string) {
  const query = new URLSearchParams({ action: 'dispatch', now: String(now) });
  if (failJobId) {
    query.set('failJobId', failJobId);
  }
  const response = await fetch(`${runtime.baseUrl}/api/evaluation-test?${query}`, {
    method: 'POST',
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function assertSent(config: RuntimeConfig, jobId: string, sent: boolean) {
  await runDatabaseCommand(config, [
    'execute',
    `
 CREATE TEMP TABLE matching (count INTEGER CHECK (count = 1));
 INSERT INTO matching SELECT COUNT(*) FROM job_outbox WHERE job_id = '${jobId}' AND ${sent ? `sent_at = ${now}` : 'sent_at IS NULL'};
 `,
  ]);
}

test(
  '予定時刻が現在から-1msなら遅延0秒で送信する',
  { timeout: 60_000, concurrent: false },
  async ({ signal }) => {
    await suite.run(async ({ config, runtime, newJobId }) => {
      const jobId = newJobId();
      await seedNotification(config, jobId, now + -1);
      expect(await dispatch(runtime)).toEqual({
        outboxSent: 1,
        outboxDeferred: 0,
        requests: [{ purpose: 'diagnostics', operation: 'notify', jobId, delaySeconds: 0 }],
      });
      await assertSent(config, jobId, true);
    }, signal);
  },
);

test(
  '予定時刻が現在から0msなら遅延0秒で送信する',
  { timeout: 60_000, concurrent: false },
  async ({ signal }) => {
    await suite.run(async ({ config, runtime, newJobId }) => {
      const jobId = newJobId();
      await seedNotification(config, jobId, now + 0);
      expect(await dispatch(runtime)).toEqual({
        outboxSent: 1,
        outboxDeferred: 0,
        requests: [{ purpose: 'diagnostics', operation: 'notify', jobId, delaySeconds: 0 }],
      });
      await assertSent(config, jobId, true);
    }, signal);
  },
);

test(
  '予定時刻が現在から1msなら遅延1秒で送信する',
  { timeout: 60_000, concurrent: false },
  async ({ signal }) => {
    await suite.run(async ({ config, runtime, newJobId }) => {
      const jobId = newJobId();
      await seedNotification(config, jobId, now + 1);
      expect(await dispatch(runtime)).toEqual({
        outboxSent: 1,
        outboxDeferred: 0,
        requests: [{ purpose: 'diagnostics', operation: 'notify', jobId, delaySeconds: 1 }],
      });
      await assertSent(config, jobId, true);
    }, signal);
  },
);

test(
  '予定時刻が現在から1001msなら遅延2秒で送信する',
  { timeout: 60_000, concurrent: false },
  async ({ signal }) => {
    await suite.run(async ({ config, runtime, newJobId }) => {
      const jobId = newJobId();
      await seedNotification(config, jobId, now + 1001);
      expect(await dispatch(runtime)).toEqual({
        outboxSent: 1,
        outboxDeferred: 0,
        requests: [{ purpose: 'diagnostics', operation: 'notify', jobId, delaySeconds: 2 }],
      });
      await assertSent(config, jobId, true);
    }, signal);
  },
);

test(
  '予定時刻が現在から86400000msなら遅延86400秒で送信する',
  { timeout: 60_000, concurrent: false },
  async ({ signal }) => {
    await suite.run(async ({ config, runtime, newJobId }) => {
      const jobId = newJobId();
      await seedNotification(config, jobId, now + 86400000);
      expect(await dispatch(runtime)).toEqual({
        outboxSent: 1,
        outboxDeferred: 0,
        requests: [{ purpose: 'diagnostics', operation: 'notify', jobId, delaySeconds: 86400 }],
      });
      await assertSent(config, jobId, true);
    }, signal);
  },
);

test(
  '24時間の上限を1ms越える予定は未送信のまま残す',
  { timeout: 60_000, concurrent: false },
  async ({ signal }) => {
    await suite.run(async ({ config, runtime, newJobId }) => {
      const jobId = newJobId();
      await seedNotification(config, jobId, now + 86_400_001);
      expect(await dispatch(runtime)).toEqual({ outboxSent: 0, outboxDeferred: 0, requests: [] });
      await assertSent(config, jobId, false);
    }, signal);
  },
);

test(
  '次回試行時刻がoutboxより遅い場合は次回試行を早めない',
  { timeout: 60_000, concurrent: false },
  async ({ signal }) => {
    await suite.run(async ({ config, runtime, newJobId }) => {
      const jobId = newJobId();
      await seedNotification(config, jobId, now, now + 1_001);
      expect(await dispatch(runtime)).toEqual({
        outboxSent: 1,
        outboxDeferred: 0,
        requests: [{ purpose: 'diagnostics', operation: 'notify', jobId, delaySeconds: 2 }],
      });
      await assertSent(config, jobId, true);
    }, signal);
  },
);

test(
  '中央の通知が失敗しても後続を送信し復旧後は失敗分だけ送る',
  { timeout: 60_000, concurrent: false },
  async ({ signal }) => {
    await suite.run(async ({ config, runtime, newJobId }) => {
      const first = newJobId(),
        middle = newJobId(),
        last = newJobId();
      await seedNotification(config, first, now - 3);
      await seedNotification(config, middle, now - 2);
      await seedNotification(config, last, now - 1);
      expect(await dispatch(runtime, middle)).toEqual({
        outboxSent: 2,
        outboxDeferred: 1,
        requests: [
          { purpose: 'diagnostics', operation: 'notify', jobId: first, delaySeconds: 0 },
          { purpose: 'diagnostics', operation: 'notify', jobId: middle, delaySeconds: 0 },
          { purpose: 'diagnostics', operation: 'notify', jobId: last, delaySeconds: 0 },
        ],
      });
      await assertSent(config, first, true);
      await assertSent(config, middle, false);
      await assertSent(config, last, true);
      expect(await dispatch(runtime)).toEqual({
        outboxSent: 1,
        outboxDeferred: 0,
        requests: [{ purpose: 'diagnostics', operation: 'notify', jobId: middle, delaySeconds: 0 }],
      });
      await assertSent(config, middle, true);
    }, signal);
  },
);
