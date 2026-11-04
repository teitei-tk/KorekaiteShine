import { Temporal } from '@js-temporal/polyfill';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { RuntimeConfig } from '@korekaite/runtime-config';
import { runDatabaseCommand, type LocalRuntime } from '../src/runtime.ts';
import { withDiagnosticRuntime } from './helpers/diagnostic-runtime.ts';

async function accept(runtime: LocalRuntime): Promise<string> {
  const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ scenario: 'success' }),
  });
  expect(response.status).toBe(202);
  const body: { jobId: string } = await response.json();
  return body.jobId;
}
function initialize(runtime: LocalRuntime, objectId: string, jobId: string) {
  return fetch(`${runtime.baseUrl}/api/check-object-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ objectId, jobId }),
  });
}
async function readInitialization(runtime: LocalRuntime, objectId: string) {
  const query = new URLSearchParams({ view: 'initialization', objectId });
  const response = await fetch(`${runtime.baseUrl}/api/check-object-test?${query}`);
  expect(response.status).toBe(200);
  return response.json();
}
async function assertUntouched(config: RuntimeConfig, jobId: string) {
  await runDatabaseCommand(config, [
    'execute',
    `
 CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
 INSERT INTO one SELECT COUNT(*) FROM diagnostic_checks WHERE job_id = '${jobId}' AND do_persistence = 'pending' AND first_received_at IS NULL;
 INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE job_id = '${jobId}' AND operation = 'initialize_do' AND sent_at IS NULL;
 CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
 INSERT INTO zero SELECT COUNT(*) FROM job_outbox WHERE job_id = '${jobId}' AND operation = 'notify';
 INSERT INTO zero SELECT COUNT(*) FROM connection_checks WHERE writer = 'queue:${jobId}';
 `,
  ]);
}

test('DO入口は不正UUIDを拒否しstorageとD1を変更しない', async () => {
  await withDiagnosticRuntime({ checkObjectProbe: 'normal' }, async (config, runtime) => {
    const jobId = await accept(runtime);
    const response = await initialize(runtime, jobId, 'not-a-uuid');
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain('診断ジョブIDが不正です。');
    expect(await readInitialization(runtime, jobId)).toBeNull();
    await assertUntouched(config, jobId);
    const valid = await initialize(runtime, jobId, jobId);
    expect(valid.status).toBe(200);
    expect(await readInitialization(runtime, jobId)).toEqual(await valid.json());
  });
}, 60_000);

test('保存済みDOへ別ジョブを渡すと元の値を保持し別ジョブに通知しない', async () => {
  await withDiagnosticRuntime({ checkObjectProbe: 'normal' }, async (config, runtime) => {
    const first = await accept(runtime),
      other = await accept(runtime);
    const initialized = await initialize(runtime, first, first);
    expect(initialized.status).toBe(200);
    const saved = await initialized.json();
    const rejected = await initialize(runtime, first, other);
    expect(rejected.status).toBe(500);
    expect((await rejected.json()).error).toContain('DOとジョブの対応が一致しません。');
    expect(await readInitialization(runtime, first)).toEqual(saved);
    expect(await readInitialization(runtime, other)).toBeNull();
    await assertUntouched(config, other);
    const receivedAt = Temporal.Instant.from(saved.firstReceivedAt).epochMilliseconds;
    await runDatabaseCommand(config, [
      'execute',
      `
   CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
   INSERT INTO one SELECT COUNT(*) FROM diagnostic_checks WHERE job_id = '${first}' AND first_received_at = ${receivedAt} AND do_persistence = 'passed';
   INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE job_id = '${first}' AND operation = 'notify';
  `,
    ]);
  });
}, 60_000);

test('許可外APP_ENVのDOは保存と通知より前に初期化を拒否する', async () => {
  await withDiagnosticRuntime(
    { checkObjectProbe: 'forbidden-environment' },
    async (config, runtime) => {
      expect(config.environment).toBe('test');
      const jobId = await accept(runtime);
      const response = await initialize(runtime, jobId, jobId);
      expect(response.status).toBe(500);
      expect((await response.json()).error).toContain('診断DOを利用できない環境です。');
      expect(await readInitialization(runtime, jobId)).toBeNull();
      await assertUntouched(config, jobId);
    },
  );
}, 60_000);
