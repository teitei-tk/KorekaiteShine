import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('同じ診断ジョブでDOを二回初期化しても初回保存日時を維持する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const acceptedResponse = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"success"}',
    });
    expect(acceptedResponse.status).toBe(202);
    const accepted = await acceptedResponse.json();
    const initialize = () =>
      fetch(`${runtime.baseUrl}/api/check-object-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: accepted.jobId }),
      });
    const first = await initialize();
    expect(first.status).toBe(200);
    const saved = await first.json();
    expect(saved).toEqual({
      jobId: accepted.jobId,
      firstReceivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
    });
    const repeated = await initialize();
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(saved);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('DO保存確認と通知outboxを一体保存し、再初期化でも各1件を維持する', async () => {
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
    for (let attempt = 0; attempt < 2; attempt++) {
      const initialized = await fetch(`${runtime.baseUrl}/api/check-object-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: accepted.jobId }),
      });
      expect(initialized.status).toBe(200);
      const stored = await initialized.json();
      const firstReceivedAt = Date.parse(stored.firstReceivedAt);
      expect(Number.isFinite(firstReceivedAt)).toBe(true);
      const status = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`);
      expect((await status.json()).checks.doPersistence).toBe('passed');
      await runDatabaseCommand(config, [
        'execute',
        `
        CREATE TEMP TABLE saved_once (count INTEGER CHECK (count = 1));
        INSERT INTO saved_once SELECT COUNT(*) FROM diagnostic_checks WHERE do_persistence = 'passed' AND first_received_at = ${firstReceivedAt};
        INSERT INTO saved_once SELECT COUNT(*) FROM job_outbox WHERE operation = 'initialize_do' AND sent_at IS NOT NULL;
        INSERT INTO saved_once SELECT COUNT(*) FROM job_outbox WHERE operation = 'notify' AND purpose = 'diagnostics' AND generation = 0;
      `,
      ]);
    }
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('DO保存後にD1の通知記録が失敗しても、再起動後に初回日時を保って回復する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  let runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"success"}',
    });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    const initialize = () =>
      fetch(`${runtime.baseUrl}/api/check-object-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: accepted.jobId }),
      });
    await runDatabaseCommand(config, [
      'execute',
      "CREATE TRIGGER reject_notification BEFORE INSERT ON job_outbox WHEN NEW.operation = 'notify' BEGIN SELECT RAISE(FAIL, 'simulated_outbox_failure'); END;",
    ]);
    expect((await initialize()).status).toBe(500);
    const failureObservedAt = Date.now();
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE still_pending (count INTEGER CHECK (count = 1));
      INSERT INTO still_pending SELECT COUNT(*) FROM diagnostic_checks WHERE do_persistence = 'pending' AND first_received_at IS NULL;
      INSERT INTO still_pending SELECT COUNT(*) FROM job_outbox WHERE operation = 'initialize_do' AND sent_at IS NULL;
      INSERT INTO still_pending SELECT COUNT(*) FROM jobs WHERE updated_at = accepted_at;
      CREATE TEMP TABLE no_notification (count INTEGER CHECK (count = 0));
      INSERT INTO no_notification SELECT COUNT(*) FROM job_outbox WHERE operation = 'notify';
    `,
    ]);
    await runtime.stop();
    await runDatabaseCommand(config, ['execute', 'DROP TRIGGER reject_notification;']);
    runtime = await startRuntime(config);
    const recovered = await initialize();
    expect(recovered.status).toBe(200);
    const saved = await recovered.json();
    expect(saved.jobId).toBe(accepted.jobId);
    expect(Date.parse(saved.firstReceivedAt)).toBeLessThanOrEqual(failureObservedAt);
    expect(Date.parse(saved.firstReceivedAt)).toBeGreaterThanOrEqual(
      Date.parse(accepted.acceptedAt),
    );
    const status = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`);
    expect((await status.json()).checks.doPersistence).toBe('passed');
    await runDatabaseCommand(config, [
      'execute',
      `CREATE TEMP TABLE recovered_once (count INTEGER CHECK (count = 1)); INSERT INTO recovered_once SELECT COUNT(*) FROM job_outbox WHERE operation = 'notify';`,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('DOから送った2項目の通知が診断Queueを経由してEvaluationへ自動配送される', async () => {
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
    const initialized = await fetch(`${runtime.baseUrl}/api/check-object-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: accepted.jobId }),
    });
    expect(initialized.status).toBe(200);
    let receipt = null;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const observed = await fetch(
        `${runtime.baseUrl}/api/check-object-test?jobId=${accepted.jobId}`,
      );
      expect(observed.status).toBe(200);
      receipt = await observed.json();
      if (receipt !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(receipt).toEqual({
      queue: config.queues.diagnostics?.queue,
      message: { schemaVersion: 1, jobId: accepted.jobId },
    });
    await runDatabaseCommand(config, [
      'execute',
      `CREATE TEMP TABLE sent_once (count INTEGER CHECK (count = 1)); INSERT INTO sent_once SELECT COUNT(*) FROM job_outbox WHERE operation = 'notify' AND sent_at IS NOT NULL;`,
    ]);
    const status = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`);
    // ここでは配送先の確認だけ。評価処理の完了を偽装しない。
    expect((await status.json()).checks.consumerCompletion).toBe('pending');
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);
