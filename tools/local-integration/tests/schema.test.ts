import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { runDatabaseCommand } from '../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('評価枠・試行履歴・配送異常・削除記録を保存し、各識別子の重複を拒否する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  let succeeded = false;
  try {
    await runDatabaseCommand(config, ['migrate']);
    await runDatabaseCommand(config, [
      'execute',
      `
      INSERT INTO jobs (job_id, actor_id, purpose, status, accepted_at, updated_at) VALUES ('job-a', 'actor-a', 'diagnostics', 'pending', 0, 0);
      INSERT INTO execution_slots (actor_id, job_id, owner_token, generation, lease_until) VALUES ('actor-a', 'job-a', 'owner-a', 1, 180000);
      INSERT INTO job_attempts (job_id, attempt_number, started_at) VALUES ('job-a', 1, 0);
      INSERT INTO delivery_anomalies (queue_name, message_id, code, expected_purpose, schema_version, job_id, first_detected_at, last_detected_at, status) VALUES ('check-queue', 'message-a', 'JOB_NOT_FOUND', 'diagnostics', 1, 'missing-job', 0, 0, 'unresolved');
      INSERT INTO deleted_jobs (job_id, deleted_at) VALUES ('deleted-job', 0);
    `,
    ]);
    for (const statement of [
      "INSERT INTO execution_slots (actor_id, job_id, owner_token, generation, lease_until) VALUES ('actor-a', 'job-a', 'owner-b', 2, 180000)",
      "INSERT INTO job_attempts (job_id, attempt_number, started_at) VALUES ('job-a', 1, 1)",
      "INSERT INTO delivery_anomalies (queue_name, message_id, code, expected_purpose, first_detected_at, last_detected_at, status) VALUES ('check-queue', 'message-a', 'JOB_NOT_FOUND', 'diagnostics', 1, 1, 'unresolved')",
      "INSERT INTO deleted_jobs (job_id, deleted_at) VALUES ('deleted-job', 1)",
    ]) {
      await expect(runDatabaseCommand(config, ['execute', statement])).rejects.toThrow(
        'DB execute失敗',
      );
      expect(await readFile(join(config.artifactDirectory, 'db-execute.log'), 'utf8')).toContain(
        'UNIQUE constraint failed',
      );
    }
    // 同じ通知IDでも別Queueなら別の配送。存在しないジョブを隔離記録できる。
    await runDatabaseCommand(config, [
      'execute',
      `INSERT INTO delivery_anomalies (queue_name, message_id, code, expected_purpose, first_detected_at, last_detected_at, status) VALUES ('check-dlq', 'message-a', 'JOB_NOT_FOUND', 'diagnostics', 1, 1, 'unresolved');`,
    ]);
    succeeded = true;
  } finally {
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('ジョブの試行回数と履歴番号は規定範囲の整数だけを保存できる', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  let succeeded = false;
  try {
    await runDatabaseCommand(config, ['migrate']);
    await runDatabaseCommand(config, [
      'execute',
      "INSERT INTO jobs (job_id, actor_id, purpose, status, accepted_at, updated_at) VALUES ('bounded-job', 'actor-a', 'diagnostics', 'pending', 0, 0)",
    ]);
    for (const count of [-1, 5, 1.5]) {
      await expect(
        runDatabaseCommand(config, ['execute', `UPDATE jobs SET attempt_count = ${count}`]),
      ).rejects.toThrow('DB execute失敗');
      expect(await readFile(join(config.artifactDirectory, 'db-execute.log'), 'utf8')).toContain(
        'CHECK constraint failed',
      );
    }
    for (const number of [0, 5, 1.5]) {
      await expect(
        runDatabaseCommand(config, [
          'execute',
          `INSERT INTO job_attempts (job_id, attempt_number, started_at) VALUES ('bounded-job', ${number}, 0)`,
        ]),
      ).rejects.toThrow('DB execute失敗');
      expect(await readFile(join(config.artifactDirectory, 'db-execute.log'), 'utf8')).toContain(
        'CHECK constraint failed',
      );
    }
    await runDatabaseCommand(config, [
      'execute',
      "UPDATE jobs SET attempt_count = 4; INSERT INTO job_attempts (job_id, attempt_number, started_at) VALUES ('bounded-job', 1, 0), ('bounded-job', 4, 0)",
    ]);
    succeeded = true;
  } finally {
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('CHECK制約を加えるテーブル置換SQLは既存ジョブと関連行を保持する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  let succeeded = false;
  try {
    await runDatabaseCommand(config, ['migrate']);
    await runDatabaseCommand(config, [
      'execute',
      `
      INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at, owner_token, generation, lease_until) VALUES ('kept-job', 'kept-actor', 'diagnostics', 'running', 1, 100, 200, 'kept-owner', 1, 180000);
      INSERT INTO execution_slots (actor_id, job_id, owner_token, generation, lease_until) VALUES ('kept-actor', 'kept-job', 'kept-owner', 1, 180000);
      INSERT INTO job_attempts (job_id, attempt_number, started_at, result_json) VALUES ('kept-job', 1, 200, '{"kept":true}');
      INSERT INTO job_outbox (id, job_id, purpose, operation, scheduled_at) VALUES ('kept-outbox', 'kept-job', 'diagnostics', 'notify', 200);
      INSERT INTO diagnostic_requests (id, environment, actor_id, operation, idempotency_key, scenario, job_id, accepted_at) VALUES ('kept-request', 'test', 'kept-actor', 'start_check', 'kept-key', 'success', 'kept-job', 100);
      INSERT INTO diagnostic_checks (job_id, scenario, do_persistence, consumer_completion, dlq_receipt) VALUES ('kept-job', 'success', 'passed', 'pending', 'not_expected');
    `,
    ]);
    const migration = await readFile(
      join(repositoryRoot, 'packages/database/db/migrations/20261102101336_wide_zombie.sql'),
      'utf8',
    );
    // Voidのmigration runnerと同じく、1ファイルをIMMEDIATE transactionで適用する。
    await runDatabaseCommand(config, ['execute', `BEGIN IMMEDIATE;\n${migration}\nCOMMIT;`]);
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE kept_assertion (count INTEGER CHECK (count = 1));
      INSERT INTO kept_assertion SELECT COUNT(*) FROM jobs WHERE job_id = 'kept-job' AND status = 'running' AND attempt_count = 1 AND owner_token = 'kept-owner' AND accepted_at = 100 AND updated_at = 200;
      INSERT INTO kept_assertion SELECT COUNT(*) FROM job_attempts WHERE job_id = 'kept-job' AND attempt_number = 1 AND result_json = '{"kept":true}';
      INSERT INTO kept_assertion SELECT COUNT(*) FROM execution_slots WHERE job_id = 'kept-job' AND owner_token = 'kept-owner';
      INSERT INTO kept_assertion SELECT COUNT(*) FROM job_outbox WHERE id = 'kept-outbox' AND job_id = 'kept-job';
      INSERT INTO kept_assertion SELECT COUNT(*) FROM diagnostic_requests WHERE id = 'kept-request' AND job_id = 'kept-job';
      INSERT INTO kept_assertion SELECT COUNT(*) FROM diagnostic_checks WHERE job_id = 'kept-job' AND do_persistence = 'passed';
      CREATE TEMP TABLE foreign_key_assertion (count INTEGER CHECK (count = 0));
      INSERT INTO foreign_key_assertion SELECT COUNT(*) FROM pragma_foreign_key_check;
    `,
    ]);
    succeeded = true;
  } finally {
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);
