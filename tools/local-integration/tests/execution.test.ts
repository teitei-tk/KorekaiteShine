import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('成功評価は実行権を取得し、試行1回の結果と完了を一体保存して枠を解放する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const acceptedResponse = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"success"}',
    });
    expect(acceptedResponse.status).toBe(202);
    const accepted = await acceptedResponse.json();
    const response = await fetch(`${runtime.baseUrl}/api/evaluation-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, jobId: accepted.jobId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: 'ack' });
    const status = await (
      await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)
    ).json();
    expect(status).toMatchObject({
      status: 'completed',
      attemptCount: 1,
      checks: { consumerCompletion: 'passed' },
    });
    expect(status.finishedAt).not.toBeNull();
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE completed_once (count INTEGER CHECK (count = 1));
      INSERT INTO completed_once SELECT COUNT(*) FROM jobs WHERE status = 'completed' AND owner_token IS NULL AND lease_until IS NULL;
      INSERT INTO completed_once SELECT COUNT(*) FROM job_attempts WHERE attempt_number = 1 AND finished_at IS NOT NULL AND json_extract(result_json, '$.summary') = 'ローカル診断の評価が完了しました。';
      CREATE TEMP TABLE released (count INTEGER CHECK (count = 0));
      INSERT INTO released SELECT COUNT(*) FROM execution_slots;
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);

test('完了後の再配送は評価を再実行せずackする', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const acceptedResponse = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"success"}',
    });
    expect(acceptedResponse.status).toBe(202);
    const accepted = await acceptedResponse.json();
    const deliver = () =>
      fetch(`${runtime.baseUrl}/api/evaluation-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, jobId: accepted.jobId }),
      });
    expect(await (await deliver()).json()).toEqual({ action: 'ack' });
    const before = await (
      await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)
    ).json();
    expect(await (await deliver()).json()).toEqual({ action: 'ack' });
    const after = await (
      await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)
    ).json();
    expect(after).toEqual(before);
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE once (count INTEGER CHECK (count = 1));
      INSERT INTO once SELECT COUNT(*) FROM job_attempts;
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);

test('同じジョブの同時配送は一つだけが評価し、有効な実行権を持つ重複配送をackする', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"success"}',
    });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    const deliver = (hold = false) =>
      fetch(`${runtime.baseUrl}/api/evaluation-test?hold=${hold}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, jobId: accepted.jobId }),
      });
    const first = deliver(true);
    try {
      await expect
        .poll(
          async () =>
            (
              await (
                await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)
              ).json()
            ).status,
          { timeout: 5_000, interval: 50 },
        )
        .toBe('running');
      const duplicate = await deliver();
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual({ action: 'ack' });
    } finally {
      await runDatabaseCommand(config, [
        'execute',
        `INSERT INTO connection_checks (writer, value) VALUES ('release:${accepted.jobId}', 'yes');`,
      ]);
      expect(await (await first).json()).toEqual({ action: 'ack' });
    }
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE executed_once (count INTEGER CHECK (count = 1));
      INSERT INTO executed_once SELECT COUNT(*) FROM job_attempts;
      INSERT INTO executed_once SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
      INSERT INTO executed_once SELECT COUNT(*) FROM jobs WHERE status = 'completed' AND attempt_count = 1;
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);

test('別ジョブが本人枠を使用中なら試行せず次回通知を保存してackする', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const accept = async () => {
      const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: '{"scenario":"success"}',
      });
      expect(response.status).toBe(202);
      return response.json();
    };
    const firstJob = await accept();
    const waitingJob = await accept();
    const deliver = (jobId: string, hold = false) =>
      fetch(`${runtime.baseUrl}/api/evaluation-test?hold=${hold}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, jobId }),
      });
    const first = deliver(firstJob.jobId, true);
    try {
      await expect
        .poll(
          async () =>
            (
              await (
                await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${firstJob.jobId}`)
              ).json()
            ).status,
          { timeout: 5_000, interval: 50 },
        )
        .toBe('running');
      const before = Temporal.Now.instant().epochMilliseconds;
      expect(await (await deliver(waitingJob.jobId)).json()).toEqual({ action: 'ack' });
      const waiting = await (
        await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${waitingJob.jobId}`)
      ).json();
      expect(waiting).toMatchObject({ status: 'pending', attemptCount: 0 });
      expect(Temporal.Instant.from(waiting.nextAttemptAt).epochMilliseconds).toBeGreaterThanOrEqual(
        before + 30_000,
      );
      expect(await (await deliver(waitingJob.jobId)).json()).toEqual({ action: 'ack' });
      await runDatabaseCommand(config, [
        'execute',
        `
        CREATE TEMP TABLE wait_once (count INTEGER CHECK (count = 1));
        INSERT INTO wait_once SELECT COUNT(*) FROM job_outbox WHERE job_id = '${waitingJob.jobId}' AND operation = 'notify' AND sent_at IS NULL;
        INSERT INTO wait_once SELECT COUNT(*) FROM execution_slots;
        INSERT INTO wait_once SELECT COUNT(*) FROM job_attempts;
        INSERT INTO wait_once SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
      `,
      ]);
    } finally {
      await runDatabaseCommand(config, [
        'execute',
        `INSERT INTO connection_checks (writer, value) VALUES ('release:${firstJob.jobId}', 'yes');`,
      ]);
      expect(await (await first).json()).toEqual({ action: 'ack' });
    }
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);

test('一時失敗は次回通知を保存し、期限前には試行せず、2回目の成功後も最後のエラーを保持する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"retry_then_success"}',
    });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    const now = Temporal.Instant.from(accepted.acceptedAt).epochMilliseconds;
    const deliver = async (time: number) => {
      const delivered = await fetch(`${runtime.baseUrl}/api/evaluation-test?now=${time}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, jobId: accepted.jobId }),
      });
      expect(delivered.status).toBe(200);
      return delivered.json();
    };
    const getStatus = async () =>
      (await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)).json();
    expect(await deliver(now)).toEqual({ action: 'ack' });
    const waiting = await getStatus();
    expect(waiting).toMatchObject({
      status: 'retry_wait',
      attemptCount: 1,
      nextAttemptAt: Temporal.Instant.fromEpochMilliseconds(now + 30_000).toString({
        fractionalSecondDigits: 3,
      }),
      lastErrorCode: 'SIMULATED_AI_FAILURE',
      checks: { consumerCompletion: 'pending', dlqReceipt: 'not_expected' },
    });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE pending_notification (count INTEGER CHECK (count = 1));
      INSERT INTO pending_notification SELECT COUNT(*) FROM job_outbox WHERE operation = 'notify' AND scheduled_at = ${now + 30_000} AND sent_at IS NULL;
      INSERT INTO pending_notification SELECT COUNT(*) FROM job_attempts WHERE finished_at = ${now} AND error_code = 'SIMULATED_AI_FAILURE';
      CREATE TEMP TABLE released (count INTEGER CHECK (count = 0));
      INSERT INTO released SELECT COUNT(*) FROM execution_slots;
    `,
    ]);
    expect(await deliver(now + 29_999)).toEqual({ action: 'ack' });
    expect(await getStatus()).toEqual(waiting);
    expect(await deliver(now + 30_000)).toEqual({ action: 'ack' });
    expect(await getStatus()).toMatchObject({
      status: 'completed',
      attemptCount: 2,
      nextAttemptAt: null,
      lastErrorCode: 'SIMULATED_AI_FAILURE',
      checks: { consumerCompletion: 'passed', dlqReceipt: 'not_expected' },
    });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE twice (count INTEGER CHECK (count = 2));
      INSERT INTO twice SELECT COUNT(*) FROM job_attempts;
      INSERT INTO twice SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);

test('全4回失敗した評価は30・120・300秒後に再試行し、失敗確定とDLQ送信待ちを保存する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"exhaust_retries"}',
    });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    let now = Temporal.Instant.from(accepted.acceptedAt).epochMilliseconds;
    const delays = [30_000, 120_000, 300_000];
    const deliver = async () => {
      const delivered = await fetch(`${runtime.baseUrl}/api/evaluation-test?now=${now}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, jobId: accepted.jobId }),
      });
      expect(delivered.status).toBe(200);
      expect(await delivered.json()).toEqual({ action: 'ack' });
    };
    const getStatus = async () =>
      (await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)).json();
    for (let attempt = 1; attempt <= 4; attempt++) {
      await deliver();
      const status = await getStatus();
      expect(status.attemptCount).toBe(attempt);
      expect(status.lastErrorCode).toBe('SIMULATED_AI_FAILURE');
      expect(status.checks).toMatchObject({
        consumerCompletion: 'not_expected',
        dlqReceipt: 'pending',
      });
      if (attempt < 4) {
        const next = now + delays[attempt - 1];
        expect(status).toMatchObject({
          status: 'retry_wait',
          finishedAt: null,
          nextAttemptAt: Temporal.Instant.fromEpochMilliseconds(next).toString({
            fractionalSecondDigits: 3,
          }),
        });
        now = next - 1;
        await deliver();
        expect(await getStatus()).toEqual(status);
        now = next;
      } else {
        expect(status).toMatchObject({
          status: 'failed',
          nextAttemptAt: null,
          finishedAt: Temporal.Instant.fromEpochMilliseconds(now).toString({
            fractionalSecondDigits: 3,
          }),
        });
        now += 1_000;
        await deliver();
        expect(await getStatus()).toEqual(status);
      }
    }
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE four (count INTEGER CHECK (count = 4));
      INSERT INTO four SELECT COUNT(*) FROM job_attempts WHERE error_code = 'SIMULATED_AI_FAILURE' AND finished_at IS NOT NULL AND result_json IS NULL;
      INSERT INTO four SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
      CREATE TEMP TABLE three (count INTEGER CHECK (count = 3));
      INSERT INTO three SELECT COUNT(*) FROM job_outbox WHERE operation = 'notify';
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE operation = 'notify_dlq' AND sent_at IS NULL;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM execution_slots;
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);

test('Web受付からDO・ローカルQueue・評価Consumerを経てD1の成功結果まで自動で保存する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"success"}',
    });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    await expect
      .poll(
        async () =>
          await (
            await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)
          ).json(),
        { timeout: 8_000, interval: 100 },
      )
      .toMatchObject({
        status: 'completed',
        attemptCount: 1,
        checks: {
          doPersistence: 'passed',
          consumerCompletion: 'passed',
          dlqReceipt: 'not_expected',
        },
      });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM job_attempts WHERE result_json IS NOT NULL AND finished_at IS NOT NULL;
      INSERT INTO one SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'queue-message:%';
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);
