import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('存在しないジョブの通知は配送異常を保存してackし、ジョブや評価を作らない', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const jobId = randomUUID();
    const response = await fetch(`${runtime.baseUrl}/api/evaluation-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, jobId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: 'ack' });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM delivery_anomalies WHERE queue_name = 'test-rpc' AND code = 'JOB_NOT_FOUND' AND expected_purpose = 'diagnostics' AND job_id = '${jobId}' AND schema_version = 1 AND observed_purpose IS NULL AND status = 'unresolved';
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM jobs;
      INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      INSERT INTO zero SELECT COUNT(*) FROM execution_slots;
      INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('隔離記録を保存できない場合はackせずretryし、復旧後に保存してackする', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const jobId = randomUUID();
    const deliver = async () => {
      const response = await fetch(`${runtime.baseUrl}/api/evaluation-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, jobId }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    await runDatabaseCommand(config, [
      'execute',
      "CREATE TRIGGER reject_anomaly BEFORE INSERT ON delivery_anomalies BEGIN SELECT RAISE(FAIL, 'simulated_anomaly_failure'); END;",
    ]);
    expect(await deliver()).toEqual({ action: 'retry', delaySeconds: 30 });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM delivery_anomalies;
      INSERT INTO zero SELECT COUNT(*) FROM jobs;
      INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      DROP TRIGGER reject_anomaly;
    `,
    ]);
    expect(await deliver()).toEqual({ action: 'ack' });
    await runDatabaseCommand(config, [
      'execute',
      `CREATE TEMP TABLE one (count INTEGER CHECK (count = 1)); INSERT INTO one SELECT COUNT(*) FROM delivery_anomalies WHERE code = 'JOB_NOT_FOUND';`,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('用途不一致の通知は隔離してackし、元ジョブと正常な回復通知を変更しない', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const jobId = randomUUID();
    const outboxId = randomUUID();
    await runDatabaseCommand(config, [
      'execute',
      `
      INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at, generation)
        VALUES ('${jobId}', 'purpose-test', 'evaluation', 'pending', 0, 100, 100, 0);
      INSERT INTO job_outbox (id, job_id, purpose, operation, generation, scheduled_at)
        VALUES ('${outboxId}', '${jobId}', 'evaluation', 'notify', 0, 100);
    `,
    ]);
    const response = await fetch(`${runtime.baseUrl}/api/evaluation-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, jobId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: 'ack' });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM delivery_anomalies WHERE code = 'JOB_PURPOSE_MISMATCH' AND expected_purpose = 'diagnostics' AND observed_purpose = 'evaluation' AND job_id = '${jobId}';
      INSERT INTO one SELECT COUNT(*) FROM jobs WHERE job_id = '${jobId}' AND purpose = 'evaluation' AND status = 'pending' AND attempt_count = 0 AND generation = 0 AND updated_at = 100 AND owner_token IS NULL AND lease_until IS NULL;
      INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE id = '${outboxId}' AND purpose = 'evaluation' AND operation = 'notify' AND generation = 0 AND scheduled_at = 100 AND sent_at IS NULL;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      INSERT INTO zero SELECT COUNT(*) FROM execution_slots;
      INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('削除済みジョブの遅延通知は記録してackし、ジョブを復元しない', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const jobId = randomUUID();
    await runDatabaseCommand(config, [
      'execute',
      `INSERT INTO deleted_jobs (job_id, deleted_at) VALUES ('${jobId}', 100);`,
    ]);
    const response = await fetch(`${runtime.baseUrl}/api/evaluation-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, jobId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: 'ack' });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM delivery_anomalies WHERE code = 'JOB_DELETED' AND job_id = '${jobId}' AND schema_version = 1 AND observed_purpose IS NULL;
      INSERT INTO one SELECT COUNT(*) FROM deleted_jobs WHERE job_id = '${jobId}' AND deleted_at = 100;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM jobs;
      INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      INSERT INTO zero SELECT COUNT(*) FROM execution_slots;
      INSERT INTO zero SELECT COUNT(*) FROM job_outbox;
      INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('不正形式と未対応版は本文IDで照会せず、区別して隔離する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const jobId = randomUUID();
    // 契約検証より先にどちらかを照会すれば、D1エラーでretryになる。
    await runDatabaseCommand(config, [
      'execute',
      `
      ALTER TABLE jobs RENAME TO unavailable_jobs;
      ALTER TABLE deleted_jobs RENAME TO unavailable_deleted_jobs;
    `,
    ]);
    const payloads = [
      null,
      { schemaVersion: 1, jobId, extra: 'must-not-store' },
      { schemaVersion: 2, jobId },
    ];
    for (const body of payloads) {
      const response = await fetch(`${runtime.baseUrl}/api/evaluation-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ action: 'ack' });
    }
    await runDatabaseCommand(config, [
      'execute',
      `
      ALTER TABLE unavailable_jobs RENAME TO jobs;
      ALTER TABLE unavailable_deleted_jobs RENAME TO deleted_jobs;
      CREATE TEMP TABLE two (count INTEGER CHECK (count = 2));
      INSERT INTO two SELECT COUNT(*) FROM delivery_anomalies WHERE code = 'INVALID_NOTIFICATION' AND job_id IS NULL AND schema_version IS NULL AND observed_purpose IS NULL;
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM delivery_anomalies WHERE code = 'UNSUPPORTED_SCHEMA_VERSION' AND job_id IS NULL AND schema_version IS NULL AND observed_purpose IS NULL;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM jobs;
      INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('D1照会失敗を不在と判定せずretryし、隔離記録を作らない', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const jobId = randomUUID();
    await runDatabaseCommand(config, ['execute', 'ALTER TABLE jobs RENAME TO unavailable_jobs;']);
    const response = await fetch(`${runtime.baseUrl}/api/evaluation-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, jobId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: 'retry', delaySeconds: 30 });
    await runDatabaseCommand(config, [
      'execute',
      `
      ALTER TABLE unavailable_jobs RENAME TO jobs;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM delivery_anomalies;
      INSERT INTO zero SELECT COUNT(*) FROM jobs;
      INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('保存後ack前の再配送は同じ記録を更新し、別メッセージIDは別記録にする', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    const jobId = randomUUID();
    const messageId = randomUUID();
    const deliver = async (id: string, now: number) => {
      const response = await fetch(
        `${runtime.baseUrl}/api/evaluation-test?messageId=${id}&now=${now}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, jobId }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ action: 'ack' });
    };
    await deliver(messageId, 1000);
    // ack判断が配送基盤へ反映されず、保存済み通知が再受信された状態。
    await runDatabaseCommand(config, [
      'execute',
      `UPDATE delivery_anomalies SET status = 'resolved', resolution = '確認済み' WHERE message_id = '${messageId}';`,
    ]);
    await deliver(messageId, 2000);
    await deliver(randomUUID(), 3000);
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM delivery_anomalies WHERE queue_name = 'test-rpc' AND message_id = '${messageId}' AND first_detected_at = 1000 AND last_detected_at = 2000 AND status = 'resolved' AND resolution = '確認済み';
      INSERT INTO one SELECT COUNT(*) FROM delivery_anomalies WHERE job_id = '${jobId}' AND message_id <> '${messageId}' AND first_detected_at = 3000 AND last_detected_at = 3000 AND status = 'unresolved' AND resolution IS NULL;
      CREATE TEMP TABLE two (count INTEGER CHECK (count = 2));
      INSERT INTO two SELECT COUNT(*) FROM delivery_anomalies;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM jobs;
      INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('隔離済み配送は用途が後から一致しても評価を自動実行しない', async () => {
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
      body: JSON.stringify({ scenario: 'success' }),
    });
    expect(acceptedResponse.status).toBe(202);
    const { jobId } = await acceptedResponse.json();
    const messageId = randomUUID();
    const deliver = async () => {
      const response = await fetch(
        `${runtime.baseUrl}/api/evaluation-test?messageId=${messageId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, jobId }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ action: 'ack' });
    };
    await runDatabaseCommand(config, [
      'execute',
      `UPDATE jobs SET purpose = 'evaluation' WHERE job_id = '${jobId}';`,
    ]);
    await deliver();
    await runDatabaseCommand(config, [
      'execute',
      `UPDATE jobs SET purpose = 'diagnostics' WHERE job_id = '${jobId}';`,
    ]);
    await deliver();
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM delivery_anomalies WHERE message_id = '${messageId}' AND code = 'JOB_PURPOSE_MISMATCH' AND observed_purpose = 'evaluation';
      INSERT INTO one SELECT COUNT(*) FROM jobs WHERE job_id = '${jobId}' AND status = 'pending' AND attempt_count = 0 AND owner_token IS NULL;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'evaluation-call:%';
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);
