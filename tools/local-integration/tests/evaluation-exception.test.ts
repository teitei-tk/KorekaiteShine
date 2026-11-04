import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { withDiagnosticRuntime } from './helpers/diagnostic-runtime.ts';
import { runDatabaseCommand } from '../src/runtime.ts';

test('評価例外は試行・再試行通知を保存して実行権を解放し、30秒後に次の評価へ進む', async () => {
  await withDiagnosticRuntime({}, async (config, runtime) => {
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ scenario: 'success' }),
    });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    const now = Temporal.Instant.from(accepted.acceptedAt).epochMilliseconds;
    const deliver = async (time: number, rejectEvaluation = false) => {
      const delivered = await fetch(
        `${runtime.baseUrl}/api/evaluation-test?now=${time}&rejectEvaluation=${rejectEvaluation}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, jobId: accepted.jobId }),
        },
      );
      expect(delivered.status).toBe(200);
      return delivered.json();
    };
    const status = async () =>
      (await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)).json();
    expect(await deliver(now, true)).toEqual({ action: 'ack' });
    const waiting = await status();
    expect(waiting).toMatchObject({
      status: 'retry_wait',
      attemptCount: 1,
      lastErrorCode: 'AI_EXCEPTION',
    });
    expect(Temporal.Instant.from(waiting.nextAttemptAt).epochMilliseconds).toBe(now + 30_000);
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM jobs WHERE job_id = '${accepted.jobId}' AND owner_token IS NULL AND lease_until IS NULL;
      INSERT INTO one SELECT COUNT(*) FROM job_attempts WHERE job_id = '${accepted.jobId}' AND finished_at = ${now} AND error_code = 'AI_EXCEPTION';
      INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE job_id = '${accepted.jobId}' AND operation = 'notify' AND scheduled_at = ${now + 30_000} AND sent_at IS NULL;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM execution_slots;
    `,
    ]);
    expect(await deliver(now + 29_999)).toEqual({ action: 'ack' });
    expect(await status()).toEqual(waiting);
    expect(await deliver(now + 30_000)).toEqual({ action: 'ack' });
    expect(await status()).toMatchObject({ status: 'completed', attemptCount: 2 });
  });
}, 60_000);
