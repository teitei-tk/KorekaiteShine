import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('実行権の更新は本人枠と一体で行い、取得から180秒の試行期限を延長しない', async () => {
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
    const startedAt = Temporal.Instant.from(accepted.acceptedAt).epochMilliseconds;
    const acquire = await fetch(`${runtime.baseUrl}/api/lease-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'acquire',
        notification: { schemaVersion: 1, jobId: accepted.jobId },
        now: startedAt,
      }),
    });
    expect(acquire.status).toBe(200);
    const lease = await acquire.json();
    expect(lease).toMatchObject({ jobId: accepted.jobId, attemptNumber: 1 });
    const renew = await fetch(`${runtime.baseUrl}/api/lease-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'renew', lease, now: startedAt + 30_000 }),
    });
    expect(renew.status).toBe(200);
    expect(await renew.json()).toBe(true);
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE renewed (count INTEGER CHECK (count = 1));
      INSERT INTO renewed SELECT COUNT(*) FROM jobs WHERE status = 'running' AND updated_at = ${startedAt + 30_000} AND lease_until = ${startedAt + 180_000} AND attempt_deadline = ${startedAt + 180_000};
      INSERT INTO renewed SELECT COUNT(*) FROM execution_slots WHERE lease_until = ${startedAt + 180_000};
    `,
    ]);
    const complete = await fetch(`${runtime.baseUrl}/api/lease-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'complete', lease, now: startedAt + 179_999 }),
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toBe(true);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);

test('期限ちょうどから実行権の更新と結果保存を拒否し、失効した所有者を復活させない', async () => {
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
    const startedAt = Temporal.Instant.from(accepted.acceptedAt).epochMilliseconds;
    const acquire = await fetch(`${runtime.baseUrl}/api/lease-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'acquire',
        notification: { schemaVersion: 1, jobId: accepted.jobId },
        now: startedAt,
      }),
    });
    expect(acquire.status).toBe(200);
    const lease = await acquire.json();
    expect(lease).toMatchObject({ jobId: accepted.jobId, attemptNumber: 1 });
    for (const elapsed of [180_000, 180_001]) {
      for (const operation of ['renew', 'complete']) {
        const response = await fetch(`${runtime.baseUrl}/api/lease-test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation, lease, now: startedAt + elapsed }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toBe(false);
      }
    }
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE unchanged (count INTEGER CHECK (count = 1));
      INSERT INTO unchanged SELECT COUNT(*) FROM jobs WHERE status = 'running' AND updated_at = ${startedAt} AND lease_until = ${startedAt + 180_000} AND finished_at IS NULL;
      INSERT INTO unchanged SELECT COUNT(*) FROM execution_slots WHERE lease_until = ${startedAt + 180_000};
      INSERT INTO unchanged SELECT COUNT(*) FROM job_attempts WHERE finished_at IS NULL AND result_json IS NULL;
      INSERT INTO unchanged SELECT COUNT(*) FROM diagnostic_checks WHERE consumer_completion = 'pending';
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

test('所有者が新しい世代へ交代した後は古い実行権の更新と保存を拒否する', async () => {
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
    const startedAt = Temporal.Instant.from(accepted.acceptedAt).epochMilliseconds;
    const acquire = await fetch(`${runtime.baseUrl}/api/lease-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'acquire',
        notification: { schemaVersion: 1, jobId: accepted.jobId },
        now: startedAt,
      }),
    });
    expect(acquire.status).toBe(200);
    const lease = await acquire.json();
    expect(lease).toMatchObject({ jobId: accepted.jobId, attemptNumber: 1 });
    const newOwner = randomUUID();
    // 回復処理とは独立して、保存時のフェンシング条件を検証する。
    await runDatabaseCommand(config, [
      'execute',
      `
      BEGIN;
      UPDATE jobs SET owner_token = '${newOwner}', generation = generation + 1 WHERE job_id = '${accepted.jobId}';
      UPDATE execution_slots SET owner_token = '${newOwner}', generation = generation + 1 WHERE job_id = '${accepted.jobId}';
      COMMIT;
    `,
    ]);
    for (const operation of ['renew', 'complete']) {
      const response = await fetch(`${runtime.baseUrl}/api/lease-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, lease, now: startedAt + 30_000 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toBe(false);
    }
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE retained (count INTEGER CHECK (count = 1));
      INSERT INTO retained SELECT COUNT(*) FROM jobs WHERE status = 'running' AND owner_token = '${newOwner}' AND generation = 2 AND finished_at IS NULL;
      INSERT INTO retained SELECT COUNT(*) FROM execution_slots WHERE owner_token = '${newOwner}' AND generation = 2;
      INSERT INTO retained SELECT COUNT(*) FROM job_attempts WHERE finished_at IS NULL AND result_json IS NULL;
    `,
    ]);
    const complete = await fetch(`${runtime.baseUrl}/api/lease-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'complete',
        lease: { ...lease, ownerToken: newOwner, generation: 2 },
        now: startedAt + 30_000,
      }),
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toBe(true);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);

test('期限から30秒の猶予後に一度だけ再試行待ちへ回復し、新しい実行権へ引き継ぐ', async () => {
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
    const startedAt = Temporal.Instant.from(accepted.acceptedAt).epochMilliseconds;
    const notification = { schemaVersion: 1, jobId: accepted.jobId };
    const acquire = await fetch(`${runtime.baseUrl}/api/lease-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'acquire', notification, now: startedAt }),
    });
    expect(acquire.status).toBe(200);
    const lease = await acquire.json();
    const call = async (operation: string, now: number, owner = lease) => {
      const response = await fetch(`${runtime.baseUrl}/api/lease-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, notification, lease: owner, now }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await call('recover', startedAt + 209_999)).toBe(false);
    expect(await call('recover', startedAt + 210_000)).toBe(true);
    expect(await call('recover', startedAt + 210_000)).toBe(false);
    const status = await (
      await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)
    ).json();
    expect(status).toMatchObject({
      status: 'retry_wait',
      attemptCount: 1,
      lastErrorCode: 'EXECUTION_LEASE_EXPIRED',
      nextAttemptAt: Temporal.Instant.fromEpochMilliseconds(startedAt + 240_000).toString({
        fractionalSecondDigits: 3,
      }),
    });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE operation = 'notify' AND sent_at IS NULL;
      INSERT INTO one SELECT COUNT(*) FROM job_attempts WHERE finished_at = ${startedAt + 210_000} AND error_code = 'EXECUTION_LEASE_EXPIRED';
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM execution_slots;
    `,
    ]);
    expect(await call('acquire', startedAt + 239_999)).toBeNull();
    const successor = await call('acquire', startedAt + 240_000);
    expect(successor).toMatchObject({ jobId: accepted.jobId, attemptNumber: 2, generation: 2 });
    expect(successor.ownerToken).not.toBe(lease.ownerToken);
    expect(await call('complete', startedAt + 240_000)).toBe(false);
    expect(await call('complete', startedAt + 240_000, successor)).toBe(true);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);

test('停止した評価の期限切れ実行権を、再起動後のscheduledで回復する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  let runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const acceptedResponse = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"success"}',
    });
    expect(acceptedResponse.status).toBe(202);
    const accepted = await acceptedResponse.json();
    const acquire = await fetch(`${runtime.baseUrl}/api/lease-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'acquire',
        notification: { schemaVersion: 1, jobId: accepted.jobId },
        now: Temporal.Instant.from(accepted.acceptedAt).epochMilliseconds,
      }),
    });
    expect(acquire.status).toBe(200);
    expect(await acquire.json()).toMatchObject({ attemptNumber: 1 });
    await runtime.stop();
    // 待機時間を短縮し、停止中に期限と猶予が経過した状態を作る。
    const expiredAt = Temporal.Now.instant().epochMilliseconds - 31_000;
    await runDatabaseCommand(config, [
      'execute',
      `
      UPDATE jobs SET lease_until = ${expiredAt}, attempt_deadline = ${expiredAt};
      UPDATE execution_slots SET lease_until = ${expiredAt};
    `,
    ]);
    runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
    await Promise.all([runtime.runScheduled(), runtime.runScheduled()]);
    const status = await (
      await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)
    ).json();
    expect(status).toMatchObject({
      status: 'retry_wait',
      attemptCount: 1,
      lastErrorCode: 'EXECUTION_LEASE_EXPIRED',
    });
    await runtime.runScheduled();
    expect(
      await (await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)).json(),
    ).toEqual(status);
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE operation = 'notify' AND sent_at IS NOT NULL;
      INSERT INTO one SELECT COUNT(*) FROM job_attempts WHERE error_code = 'EXECUTION_LEASE_EXPIRED' AND finished_at IS NOT NULL;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM execution_slots;
    `,
    ]);
    await expect
      .poll(
        async () =>
          (await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)).json(),
        { timeout: 40_000, interval: 250 },
      )
      .toMatchObject({ status: 'completed', attemptCount: 2 });
    const completed = await (
      await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)
    ).json();
    expect(Temporal.Instant.from(completed.finishedAt).epochMilliseconds).toBeGreaterThanOrEqual(
      Temporal.Instant.from(status.nextAttemptAt).epochMilliseconds,
    );
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 90_000);
