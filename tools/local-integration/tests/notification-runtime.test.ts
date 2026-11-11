import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createNotificationRuntime } from './helpers/notification-runtime.ts';
import { runDatabaseCommand } from '../src/runtime.ts';

// cleanupを省くと前ケースの未送信通知をdispatchが拾い、次の期待値が変わる。
test('共有環境は未送信・送信失敗の通知をケース間で除去し、同じWorkerで次を検査できる', async ({
  signal,
}) => {
  const suite = createNotificationRuntime();
  await suite.start();
  const previousUrlContext = {
    previousUrl: '',
    directory: '',
    closed: undefined as Promise<{ exitCode: 0 | 1 }> | undefined,
  };
  try {
    await suite.run(async ({ config, runtime, newJobId }) => {
      previousUrlContext.previousUrl = runtime.baseUrl;
      previousUrlContext.directory = config.artifactDirectory;
      previousUrlContext.closed = runtime.closed;
      const failedId = newJobId();
      const futureId = newJobId();
      await runDatabaseCommand(config, [
        'execute',
        `
        INSERT INTO jobs(job_id, actor_id, purpose, status, attempt_count, generation, accepted_at, updated_at)
        VALUES ('${failedId}', 'local-test', 'diagnostics', 'pending', 0, 0, 1, 1),
               ('${futureId}', 'local-test', 'diagnostics', 'pending', 0, 0, 1, 1);
        INSERT INTO job_outbox(id, job_id, purpose, operation, generation, scheduled_at)
        VALUES ('${randomUUID()}', '${failedId}', 'diagnostics', 'notify', 0, 1),
               ('${randomUUID()}', '${futureId}', 'diagnostics', 'notify', 0, 86400002);
      `,
      ]);
      const response = await fetch(
        `${runtime.baseUrl}/api/evaluation-test?action=dispatch&now=1&failJobId=${failedId}`,
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ outboxSent: 0, outboxDeferred: 1 });
    }, signal);
    await suite.run(async ({ config, runtime }) => {
      expect(runtime.baseUrl).toBe(previousUrlContext.previousUrl);
      const response = await fetch(
        `${runtime.baseUrl}/api/evaluation-test?action=dispatch&now=86400002`,
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outboxSent: 0, outboxDeferred: 0, requests: [] });
      await runDatabaseCommand(config, [
        'execute',
        `
        CREATE TEMP TABLE empty_check (count INTEGER CHECK (count = 0));
        INSERT INTO empty_check SELECT COUNT(*) FROM jobs;
        INSERT INTO empty_check SELECT COUNT(*) FROM job_outbox;
      `,
      ]);
    }, signal);
  } finally {
    await suite.stop();
  }
  expect(await previousUrlContext.closed).toEqual({ exitCode: 0 });
  await expect(access(previousUrlContext.directory)).rejects.toMatchObject({ code: 'ENOENT' });
}, 60_000);
