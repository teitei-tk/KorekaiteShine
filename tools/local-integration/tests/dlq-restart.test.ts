import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';
import type { LocalRuntime } from '../src/runtime.ts';
import { runWithEvidence } from '../src/evidence.ts';
import { runtimeVersions } from '../src/versions.ts';

test('DLQ送信済み・受信保存前の停止から同じ用途へ回復し、受信済み・対象外の通知を再送しない', async () => {
  const runId = randomUUID();
  const config = resolveRuntime({
    repositoryRoot: fileURLToPath(new URL('../../../', import.meta.url)),
    appEnv: 'test',
    runId,
    parallelIndex: 0,
  });
  const diagnosticQueue = config.queues.diagnostics!.dlq;
  const formalQueue = config.queues.evaluation.dlq;
  await runWithEvidence(
    {
      resultPath: join(dirname(config.artifactDirectory), 'results.json'),
      metadata: {
        environment: 'test',
        runId,
        parallelIndex: 0,
        case: 'dlq-sent-before-receipt-restart',
        mode: 'dev',
        clock: 'real',
        versions: await runtimeVersions(),
        expected: {
          queues: [diagnosticQueue, formalQueue],
          receipts: 2,
          protectedNotifications: 5,
        },
      },
    },
    async (evidence) => {
      evidence.cleanup(async (passed) => {
        if (!passed) {
          return;
        }
        await rm(config.stateDirectory!, { recursive: true, force: true });
        await rm(config.artifactDirectory, { recursive: true, force: true });
      });
      let runtime: LocalRuntime | undefined;
      evidence.cleanup(async () => {
        await runtime?.stop();
      });
      runtime = await startRuntime(config, 'dev', {
        manualDiagnostics: true,
        holdEvaluationBeforeConsume: true,
      });
      const accepted = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ scenario: 'exhaust_retries' }),
      });
      expect(accepted.status).toBe(202);
      const { jobId } = await accepted.json();
      const formalId = randomUUID();
      const now = Temporal.Now.instant().epochMilliseconds;
      const oldSentAt = now - 60_000;
      const protectedIds = Array.from({ length: 5 }, () => randomUUID());
      const [received, wrongPurpose, staleGeneration, deleted, future] = protectedIds;
      const protectedSql = protectedIds
        .map(
          (id) => `
        INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at, generation)
        VALUES ('${id}', 'protected-test', 'diagnostics', 'failed', 4, ${now}, ${now}, 4);
        INSERT INTO job_outbox (id, job_id, purpose, operation, generation, scheduled_at, sent_at)
        VALUES ('${randomUUID()}', '${id}', '${id === wrongPurpose ? 'evaluation' : 'diagnostics'}', 'notify_dlq', ${id === staleGeneration ? 3 : 4}, ${id === future ? now + 3_600_000 : oldSentAt}, ${oldSentAt});
      `,
        )
        .join('\n');
      await runDatabaseCommand(config, [
        'execute',
        `
        DELETE FROM job_outbox WHERE job_id = '${jobId}';
        UPDATE jobs SET status = 'failed', attempt_count = 4, generation = 4, finished_at = ${now} WHERE job_id = '${jobId}';
        INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at, finished_at, generation)
        VALUES ('${formalId}', 'formal-test', 'evaluation', 'failed', 4, ${now}, ${now}, ${now}, 4);
        INSERT INTO job_outbox (id, job_id, purpose, operation, generation, scheduled_at)
        VALUES ('${randomUUID()}', '${jobId}', 'diagnostics', 'notify_dlq', 4, ${now}),
          ('${randomUUID()}', '${formalId}', 'evaluation', 'notify_dlq', 4, ${now});
        ${protectedSql}
        INSERT INTO deleted_jobs (job_id, deleted_at) VALUES ('${deleted}', ${now});
        INSERT INTO dlq_receipts (queue_name, message_id, job_id, purpose, observed_status, first_received_at, last_received_at)
        VALUES ('${diagnosticQueue}', '${randomUUID()}', '${received}', 'diagnostics', 'failed', ${now}, ${now}),
          ('${formalQueue}', '${randomUUID()}', '${jobId}', 'evaluation', 'failed', ${now}, ${now});
      `,
      ]);
      await runtime.runScheduled();
      await expect
        .poll(
          async () =>
            Promise.all(
              [jobId, formalId].map(async (id) =>
                (await fetch(`${runtime!.baseUrl}/api/check-object-test?jobId=${id}`)).json(),
              ),
            ),
          { timeout: 20_000, interval: 250 },
        )
        .toEqual([
          { queue: diagnosticQueue, message: { schemaVersion: 1, jobId } },
          { queue: formalQueue, message: { schemaVersion: 1, jobId: formalId } },
        ]);
      await runDatabaseCommand(config, [
        'execute',
        `
        CREATE TEMP TABLE two (count INTEGER CHECK (count = 2));
        INSERT INTO two SELECT COUNT(*) FROM job_outbox WHERE job_id IN ('${jobId}', '${formalId}') AND sent_at IS NOT NULL;
        CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
        INSERT INTO zero SELECT COUNT(*) FROM dlq_receipts r JOIN jobs j ON r.job_id = j.job_id AND r.purpose = j.purpose WHERE j.job_id IN ('${jobId}', '${formalId}');
      `,
      ]);
      evidence.observe({
        beforeRestart: { queues: [diagnosticQueue, formalQueue], sentWithoutReceiptVerified: true },
      });
      const stoppedAt = Temporal.Now.instant().epochMilliseconds;
      await runtime.stop();
      runtime = undefined;
      runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
      await expect
        .poll(
          async () => {
            await runtime!.runScheduled(AbortSignal.timeout(10_000));
            const diagnostic = await (
              await fetch(`${runtime!.baseUrl}/api/diagnostics/check-jobs/${jobId}`)
            ).json();
            const formal = await (
              await fetch(`${runtime!.baseUrl}/api/formal-queue-test?jobId=${formalId}&view=dlq`)
            ).json();
            evidence.observe({
              afterRestart: {
                status: diagnostic.status,
                attemptCount: diagnostic.attemptCount,
                dlqReceipt: diagnostic.checks.dlqReceipt,
                formalReceived: Array.isArray(formal) && formal.length > 0,
              },
            });
            return {
              diagnostic: diagnostic.checks.dlqReceipt,
              formalReceived: Array.isArray(formal) && formal.length > 0,
            };
          },
          { timeout: 45_000, interval: 1000 },
        )
        .toEqual({ diagnostic: 'passed', formalReceived: true });
      await runDatabaseCommand(config, [
        'execute',
        `
        CREATE TEMP TABLE two (count INTEGER CHECK (count = 2));
        INSERT INTO two SELECT COUNT(*) FROM dlq_receipts r JOIN jobs j ON r.job_id = j.job_id AND r.purpose = j.purpose WHERE j.job_id IN ('${jobId}', '${formalId}') AND r.observed_status = 'failed';
        INSERT INTO two SELECT COUNT(*) FROM jobs WHERE job_id IN ('${jobId}', '${formalId}') AND status = 'failed' AND attempt_count = 4;
        INSERT INTO two SELECT COUNT(*) FROM job_outbox WHERE job_id IN ('${jobId}', '${formalId}') AND sent_at > ${stoppedAt};
        CREATE TEMP TABLE five (count INTEGER CHECK (count = 5));
        INSERT INTO five SELECT COUNT(*) FROM job_outbox WHERE job_id IN (${protectedIds.map((id) => `'${id}'`).join(',')}) AND sent_at = ${oldSentAt};
        CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
        INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      `,
      ]);
      evidence.observe({ databaseAssertionsPassed: true });
    },
  );
}, 120_000);
