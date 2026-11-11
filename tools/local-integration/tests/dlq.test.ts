import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('DLQ確認の初回変更と公開更新日時を一体保存し、保存失敗と重複受信では日時を変えない', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });

  try {
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ scenario: 'exhaust_retries' }),
    });
    expect(response.status).toBe(202);
    const { jobId } = await response.json();
    const failedAt = Temporal.Now.instant().epochMilliseconds;
    const receivedAt = failedAt + 1000;
    const messageId = randomUUID();
    await runDatabaseCommand(config, [
      'execute',
      `UPDATE jobs SET status = 'failed', finished_at = ${failedAt}, updated_at = ${failedAt} WHERE job_id = '${jobId}';
      CREATE TRIGGER reject_confirmation BEFORE UPDATE ON diagnostic_checks WHEN NEW.dlq_receipt = 'passed' BEGIN SELECT RAISE(FAIL, 'simulated_confirmation_failure'); END;`,
    ]);
    const deliver = async (now: number) =>
      (
        await fetch(
          `${runtime.baseUrl}/api/evaluation-test?kind=dlq&messageId=${messageId}&now=${now}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schemaVersion: 1, jobId }),
          },
        )
      ).json();
    const status = async () =>
      (await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${jobId}`)).json();
    expect(await deliver(receivedAt)).toEqual({ action: 'retry', delaySeconds: 30 });
    expect(await status()).toMatchObject({
      updatedAt: Temporal.Instant.fromEpochMilliseconds(failedAt).toString({
        fractionalSecondDigits: 3,
      }),
      checks: { dlqReceipt: 'pending' },
    });
    await runDatabaseCommand(config, ['execute', 'DROP TRIGGER reject_confirmation;']);
    expect(await deliver(receivedAt)).toEqual({ action: 'ack' });
    expect(await status()).toMatchObject({
      updatedAt: Temporal.Instant.fromEpochMilliseconds(receivedAt).toString({
        fractionalSecondDigits: 3,
      }),
      finishedAt: Temporal.Instant.fromEpochMilliseconds(failedAt).toString({
        fractionalSecondDigits: 3,
      }),
      checks: { dlqReceipt: 'passed' },
    });
    expect(await deliver(receivedAt + 1000)).toEqual({ action: 'ack' });
    expect(await status()).toMatchObject({
      updatedAt: Temporal.Instant.fromEpochMilliseconds(receivedAt).toString({
        fractionalSecondDigits: 3,
      }),
      checks: { dlqReceipt: 'passed' },
    });
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('失敗確定ではDLQ確認を完了せず、ローカルDLQ配送の受信保存後にpassedにする', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });

  try {
    const acceptedResponse = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ scenario: 'exhaust_retries' }),
    });
    expect(acceptedResponse.status).toBe(202);
    const { jobId } = await acceptedResponse.json();
    const start = Temporal.Now.instant().epochMilliseconds;
    for (const offset of [0, 30_000, 150_000, 450_000]) {
      const response = await fetch(`${runtime.baseUrl}/api/evaluation-test?now=${start + offset}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, jobId }),
      });
      expect(await response.json()).toEqual({ action: 'ack' });
    }
    const statusUrl = `${runtime.baseUrl}/api/diagnostics/check-jobs/${jobId}`;
    expect(await (await fetch(statusUrl)).json()).toMatchObject({
      status: 'failed',
      attemptCount: 4,
      checks: { dlqReceipt: 'pending' },
    });
    // 仮想時計で確定した失敗通知だけを、ローカル実時計で配送可能にする。
    await runDatabaseCommand(config, [
      'execute',
      `UPDATE job_outbox SET scheduled_at = 0 WHERE job_id = '${jobId}' AND operation = 'notify_dlq';`,
    ]);
    await runtime.runScheduled();
    await expect
      .poll(async () => (await fetch(statusUrl)).json(), { timeout: 15_000, interval: 100 })
      .toMatchObject({
        status: 'failed',
        attemptCount: 4,
        checks: { dlqReceipt: 'passed' },
      });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM dlq_receipts WHERE queue_name = '${config.queues.diagnostics?.dlq}' AND job_id = '${jobId}' AND purpose = 'diagnostics' AND observed_status = 'failed';
      INSERT INTO one SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'queue-message:${config.queues.diagnostics?.dlq}:%';
      CREATE TEMP TABLE four (count INTEGER CHECK (count = 4));
      INSERT INTO four SELECT COUNT(*) FROM job_attempts;
    `,
    ]);
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('完了・取消済みのDLQ通知は状態を変えず受信記録を保存してackする', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });

  try {
    for (const status of ['completed', 'cancelled']) {
      const jobId = randomUUID();
      await runDatabaseCommand(config, [
        'execute',
        `INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at, finished_at) VALUES ('${jobId}', 'terminal-test', 'diagnostics', '${status}', 1, 100, 200, 200);`,
      ]);
      const response = await fetch(`${runtime.baseUrl}/api/evaluation-test?kind=dlq`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, jobId }),
      });
      expect(await response.json()).toEqual({ action: 'ack' });
      await runDatabaseCommand(config, [
        'execute',
        `
        CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
        INSERT INTO one SELECT COUNT(*) FROM dlq_receipts WHERE job_id = '${jobId}' AND observed_status = '${status}';
        INSERT INTO one SELECT COUNT(*) FROM jobs WHERE job_id = '${jobId}' AND status = '${status}' AND attempt_count = 1 AND updated_at = 200 AND finished_at = 200;
        CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
        INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
        INSERT INTO zero SELECT COUNT(*) FROM job_outbox;
        INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
      `,
      ]);
    }
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('DLQは有効な実行権と未来の通知を維持し、受信だけ記録する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });

  try {
    const runningId = randomUUID();
    const futureId = randomUUID();
    await runDatabaseCommand(config, [
      'execute',
      `
      INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at, owner_token, generation, lease_until, attempt_deadline)
        VALUES ('${runningId}', 'active-owner', 'diagnostics', 'running', 1, 100, 1000, 'owner-a', 1, 181000, 181000);
      INSERT INTO execution_slots (actor_id, job_id, owner_token, generation, lease_until)
        VALUES ('active-owner', '${runningId}', 'owner-a', 1, 181000);
      INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at, generation, next_attempt_at)
        VALUES ('${futureId}', 'future-owner', 'diagnostics', 'retry_wait', 1, 100, 1000, 1, 40000);
      INSERT INTO job_outbox (id, job_id, purpose, operation, generation, scheduled_at, sent_at)
        VALUES ('${randomUUID()}', '${futureId}', 'diagnostics', 'notify', 1, 40000, 1000);
    `,
    ]);
    for (const jobId of [runningId, futureId]) {
      const response = await fetch(`${runtime.baseUrl}/api/evaluation-test?kind=dlq&now=2000`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, jobId }),
      });
      expect(await response.json()).toEqual({ action: 'ack' });
    }
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM dlq_receipts WHERE job_id = '${runningId}' AND observed_status = 'running';
      INSERT INTO one SELECT COUNT(*) FROM dlq_receipts WHERE job_id = '${futureId}' AND observed_status = 'retry_wait';
      INSERT INTO one SELECT COUNT(*) FROM jobs WHERE job_id = '${runningId}' AND status = 'running' AND attempt_count = 1 AND updated_at = 1000 AND owner_token = 'owner-a' AND generation = 1 AND lease_until = 181000 AND attempt_deadline = 181000;
      INSERT INTO one SELECT COUNT(*) FROM execution_slots WHERE job_id = '${runningId}' AND owner_token = 'owner-a' AND generation = 1 AND lease_until = 181000;
      INSERT INTO one SELECT COUNT(*) FROM jobs WHERE job_id = '${futureId}' AND status = 'retry_wait' AND attempt_count = 1 AND updated_at = 1000 AND next_attempt_at = 40000;
      INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE job_id = '${futureId}' AND scheduled_at = 40000 AND sent_at = 1000 AND generation = 1;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
    `,
    ]);
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('回復経路のない未完了ジョブのDLQは通知待ちを保存し、失敗へ上書きしない', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });

  try {
    for (const status of ['pending', 'retry_wait']) {
      const jobId = randomUUID();
      const messageId = randomUUID();
      await runDatabaseCommand(config, [
        'execute',
        `
        INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at, generation, next_attempt_at)
          VALUES ('${jobId}', '${jobId}', 'diagnostics', '${status}', 0, 100, 1000, 0, 1000);
        ${status === 'retry_wait' ? `INSERT INTO job_outbox (id, job_id, purpose, operation, generation, scheduled_at, sent_at) VALUES ('${randomUUID()}', '${jobId}', 'diagnostics', 'notify', 0, 1000, 1000);` : ''}
      `,
      ]);
      for (const _ of Array(2).keys()) {
        const response = await fetch(
          `${runtime.baseUrl}/api/evaluation-test?kind=dlq&now=2000&messageId=${messageId}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schemaVersion: 1, jobId }),
          },
        );
        expect(await response.json()).toEqual({ action: 'ack' });
      }
      await runDatabaseCommand(config, [
        'execute',
        `
        CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
        INSERT INTO one SELECT COUNT(*) FROM jobs WHERE job_id = '${jobId}' AND status = '${status}' AND attempt_count = 0 AND updated_at = 1000 AND generation = 0;
        INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE job_id = '${jobId}' AND purpose = 'diagnostics' AND operation = 'notify' AND generation = 0 AND scheduled_at = 2000 AND sent_at IS NULL;
        INSERT INTO one SELECT COUNT(*) FROM dlq_receipts WHERE job_id = '${jobId}' AND message_id = '${messageId}' AND observed_status = '${status}';
        CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
        INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
        INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
      `,
      ]);
    }
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('DLQ保存失敗は受信記録とpassedを巻き戻してretryし、復旧後の重複受信は一件に集約する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });

  try {
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ scenario: 'exhaust_retries' }),
    });
    expect(response.status).toBe(202);
    const { jobId } = await response.json();
    const messageId = randomUUID();
    await runDatabaseCommand(config, [
      'execute',
      `
      UPDATE jobs SET status = 'failed', finished_at = 1000 WHERE job_id = '${jobId}';
      CREATE TRIGGER reject_dlq_confirmation BEFORE UPDATE ON diagnostic_checks WHEN NEW.dlq_receipt = 'passed' BEGIN SELECT RAISE(FAIL, 'simulated_dlq_save_failure'); END;
    `,
    ]);
    const deliver = async () =>
      (
        await fetch(`${runtime.baseUrl}/api/evaluation-test?kind=dlq&messageId=${messageId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, jobId }),
        })
      ).json();
    expect(await deliver()).toEqual({ action: 'retry', delaySeconds: 30 });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM dlq_receipts;
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM diagnostic_checks WHERE job_id = '${jobId}' AND dlq_receipt = 'pending';
      DROP TRIGGER reject_dlq_confirmation;
    `,
    ]);
    expect(await deliver()).toEqual({ action: 'ack' });
    expect(await deliver()).toEqual({ action: 'ack' });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM dlq_receipts WHERE message_id = '${messageId}' AND job_id = '${jobId}';
      INSERT INTO one SELECT COUNT(*) FROM diagnostic_checks WHERE job_id = '${jobId}' AND dlq_receipt = 'passed';
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      INSERT INTO zero SELECT COUNT(*) FROM job_outbox WHERE operation IN ('notify', 'notify_dlq');
    `,
    ]);
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('DLQが保存した回復通知を即時に通常Queueへ送り、scheduledなしで評価を再開する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtimeContext = {
    runtime: await startRuntime(config, 'dev', { probeOnlyEvaluation: true }),
  };
  try {
    const acceptedResponse = await fetch(
      `${runtimeContext.runtime.baseUrl}/api/diagnostics/check-jobs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ scenario: 'success' }),
      },
    );
    expect(acceptedResponse.status).toBe(202);
    const { jobId } = await acceptedResponse.json();
    await expect
      .poll(
        async () =>
          (
            await fetch(`${runtimeContext.runtime.baseUrl}/api/check-object-test?jobId=${jobId}`)
          ).json(),
        { timeout: 8_000, interval: 100 },
      )
      .toMatchObject({ message: { jobId } });
    await runtimeContext.runtime.stop();
    // 最初の配送はprobeだけが受信。DO保存済み・未評価の状態から本Consumerへ引き継ぐ。
    runtimeContext.runtime = await startRuntime(config, 'dev');
    const status = async () =>
      (await fetch(`${runtimeContext.runtime.baseUrl}/api/diagnostics/check-jobs/${jobId}`)).json();
    expect(await status()).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      checks: { doPersistence: 'passed' },
    });
    const response = await fetch(
      `${runtimeContext.runtime.baseUrl}/api/evaluation-test?transport=queue&kind=dlq`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, jobId }),
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ enqueued: true });
    await expect.poll(status, { timeout: 10_000, interval: 100 }).toMatchObject({
      status: 'completed',
      attemptCount: 1,
      checks: { doPersistence: 'passed', consumerCompletion: 'passed' },
    });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM dlq_receipts WHERE job_id = '${jobId}' AND observed_status = 'pending';
      INSERT INTO one SELECT COUNT(*) FROM job_attempts WHERE job_id = '${jobId}';
      INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE job_id = '${jobId}' AND operation = 'notify' AND sent_at IS NOT NULL;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM job_outbox WHERE job_id = '${jobId}' AND operation = 'notify_dlq';
    `,
    ]);
  } finally {
    await runtimeContext.runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('期限切れrunningのDLQは猶予中にackせず、回復処理の通知保存後にackする', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });

  try {
    const acceptedResponse = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ scenario: 'success' }),
    });
    expect(acceptedResponse.status).toBe(202);
    const { jobId } = await acceptedResponse.json();
    const notification = { schemaVersion: 1, jobId };
    const start = Temporal.Now.instant().epochMilliseconds;
    const lease = async (operation: 'acquire' | 'recover', now: number) =>
      (
        await fetch(`${runtime.baseUrl}/api/lease-test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation, notification, now }),
        })
      ).json();
    expect(await lease('acquire', start)).toMatchObject({ attemptNumber: 1 });
    const deliver = async (now: number) =>
      (
        await fetch(`${runtime.baseUrl}/api/evaluation-test?kind=dlq&now=${now}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(notification),
        })
      ).json();
    expect(await deliver(start + 179_999)).toEqual({ action: 'ack' });
    expect(await deliver(start + 180_000)).toEqual({ action: 'retry', delaySeconds: 30 });
    expect(await deliver(start + 209_999)).toEqual({ action: 'retry', delaySeconds: 30 });
    expect(await lease('recover', start + 209_999)).toBe(false);
    expect(await lease('recover', start + 210_000)).toBe(true);
    expect(await deliver(start + 210_000)).toEqual({ action: 'ack' });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM jobs WHERE job_id = '${jobId}' AND status = 'retry_wait' AND attempt_count = 1 AND next_attempt_at = ${start + 240_000} AND owner_token IS NULL;
      INSERT INTO one SELECT COUNT(*) FROM dlq_receipts WHERE job_id = '${jobId}' AND observed_status = 'running';
      INSERT INTO one SELECT COUNT(*) FROM dlq_receipts WHERE job_id = '${jobId}' AND observed_status = 'retry_wait';
      INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE job_id = '${jobId}' AND operation = 'notify' AND scheduled_at = ${start + 240_000};
      CREATE TEMP TABLE two (count INTEGER CHECK (count = 2));
      INSERT INTO two SELECT COUNT(*) FROM dlq_receipts;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM execution_slots;
      INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
    `,
    ]);
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);
