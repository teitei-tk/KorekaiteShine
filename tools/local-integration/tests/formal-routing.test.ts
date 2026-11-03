import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';
import { runWithEvidence } from '../src/evidence.ts';
import { runtimeVersions } from '../src/versions.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test.each(['web', 'interview'] as const)(
  '%sから正式Queueへ送った架空ジョブを同じ環境のEvaluationが処理する',
  async (source) => {
    const runId = randomUUID();
    const config = resolveRuntime({
      repositoryRoot,
      appEnv: 'test',
      runId,
      parallelIndex: 0,
    });
    await runWithEvidence(
      {
        resultPath: join(dirname(config.artifactDirectory), 'results.json'),
        metadata: {
          environment: 'test',
          runId,
          parallelIndex: 0,
          case: `formal-${source}`,
          mode: 'dev',
          clock: 'real',
          versions: await runtimeVersions(),
          expected: { status: 'completed', attemptCount: 1, queue: config.queues.evaluation.queue },
        },
      },
      async (evidence) => {
        evidence.cleanup(async (passed) => {
          if (!passed) return;
          await rm(config.stateDirectory!, { recursive: true, force: true });
          await rm(config.artifactDirectory, { recursive: true, force: true });
        });
        const runtime = await startRuntime(config);
        evidence.cleanup(() => runtime.stop());
        const jobId = randomUUID();
        const now = Date.now();
        await runDatabaseCommand(config, [
          'execute',
          `
      INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at, generation)
      VALUES ('${jobId}', 'formal-test', 'evaluation', 'pending', 0, ${now}, ${now}, 0);
    `,
        ]);
        const response = await fetch(`${runtime.baseUrl}/api/formal-queue-test?source=${source}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, jobId }),
        });
        evidence.observe({ startHttpStatus: response.status });
        expect(response.status).toBe(202);
        await expect
          .poll(
            async () => {
              const result = await fetch(`${runtime.baseUrl}/api/formal-queue-test?jobId=${jobId}`);
              expect(result.status).toBe(200);
              const job = await result.json();
              evidence.observe({
                job: {
                  jobId: job.jobId,
                  purpose: job.purpose,
                  status: job.status,
                  attemptCount: job.attemptCount,
                },
              });
              return job;
            },
            { timeout: 20_000, interval: 250 },
          )
          .toEqual({
            jobId,
            purpose: 'evaluation',
            status: 'completed',
            attemptCount: 1,
          });
        const receipt = await fetch(`${runtime.baseUrl}/api/check-object-test?jobId=${jobId}`);
        const observedReceipt = await receipt.json();
        evidence.observe({
          queue: observedReceipt.queue,
          deliveredJobId: observedReceipt.message?.jobId,
        });
        expect(observedReceipt).toEqual({
          queue: config.queues.evaluation.queue,
          message: { schemaVersion: 1, jobId },
        });
        await runDatabaseCommand(config, [
          'execute',
          `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM job_attempts WHERE job_id = '${jobId}';
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM diagnostic_checks;
      INSERT INTO zero SELECT COUNT(*) FROM delivery_anomalies;
    `,
        ]);
        evidence.observe({ databaseAssertionsPassed: true });
      },
    );
  },
  60_000,
);

test('正式DLQの受信をD1へ記録し、失敗済みの架空ジョブを再評価しない', async () => {
  const runId = randomUUID();
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId,
    parallelIndex: 0,
  });
  await runWithEvidence(
    {
      resultPath: join(dirname(config.artifactDirectory), 'results.json'),
      metadata: {
        environment: 'test',
        runId,
        parallelIndex: 0,
        case: 'formal-dlq',
        mode: 'dev',
        clock: 'real',
        versions: await runtimeVersions(),
        expected: { observedStatus: 'failed', queue: config.queues.evaluation.dlq },
      },
    },
    async (evidence) => {
      evidence.cleanup(async (passed) => {
        if (!passed) return;
        await rm(config.stateDirectory!, { recursive: true, force: true });
        await rm(config.artifactDirectory, { recursive: true, force: true });
      });
      const runtime = await startRuntime(config);
      evidence.cleanup(() => runtime.stop());
      const jobId = randomUUID();
      const now = Date.now();
      await runDatabaseCommand(config, [
        'execute',
        `
      INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at, finished_at, generation)
      VALUES ('${jobId}', 'formal-dlq-test', 'evaluation', 'failed', 4, ${now}, ${now}, ${now}, 4);
    `,
      ]);
      const response = await fetch(
        `${runtime.baseUrl}/api/formal-queue-test?source=evaluation&kind=dlq`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, jobId }),
        },
      );
      evidence.observe({ startHttpStatus: response.status });
      expect(response.status).toBe(202);
      await expect
        .poll(
          async () => {
            const result = await fetch(
              `${runtime.baseUrl}/api/formal-queue-test?jobId=${jobId}&view=dlq`,
            );
            expect(result.status).toBe(200);
            const receipts = await result.json();
            evidence.observe({
              receipts: receipts.map(
                (receipt: {
                  jobId: string;
                  purpose: string;
                  queueName: string;
                  observedStatus: string;
                }) => ({
                  jobId: receipt.jobId,
                  purpose: receipt.purpose,
                  queueName: receipt.queueName,
                  observedStatus: receipt.observedStatus,
                }),
              ),
            });
            return receipts;
          },
          { timeout: 20_000, interval: 250 },
        )
        .toEqual([
          {
            jobId,
            purpose: 'evaluation',
            queueName: config.queues.evaluation.dlq,
            observedStatus: 'failed',
          },
        ]);
      const receipt = await fetch(`${runtime.baseUrl}/api/check-object-test?jobId=${jobId}`);
      const observedReceipt = await receipt.json();
      evidence.observe({
        queue: observedReceipt.queue,
        deliveredJobId: observedReceipt.message?.jobId,
      });
      expect(observedReceipt).toEqual({
        queue: config.queues.evaluation.dlq,
        message: { schemaVersion: 1, jobId },
      });
      await runDatabaseCommand(config, [
        'execute',
        `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM jobs WHERE job_id = '${jobId}' AND status = 'failed' AND attempt_count = 4 AND generation = 4;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      INSERT INTO zero SELECT COUNT(*) FROM job_outbox;
      INSERT INTO zero SELECT COUNT(*) FROM diagnostic_checks;
      INSERT INTO zero SELECT COUNT(*) FROM delivery_anomalies;
    `,
      ]);
      evidence.observe({ databaseAssertionsPassed: true });
    },
  );
}, 60_000);
