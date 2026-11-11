import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { runDatabaseCommand } from '../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('公式migrateで旧履歴から追加適用しても既存行を保持し、再適用では重複しない', async () => {
  const { prepareMigrationFixture } =
    await import('../../../packages/database/testing/database.ts');
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const fixture = join(config.artifactDirectory, 'migration-source');

  try {
    await prepareMigrationFixture(fixture, '20261102094333_many_post');
    await runDatabaseCommand(config, ['migrate'], { schemaDirectory: fixture });
    await runDatabaseCommand(
      config,
      [
        'execute',
        `
      INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at) VALUES ('existing-job', 'existing-actor', 'diagnostics', 'pending', 0, 100, 100);
      INSERT INTO job_outbox (id, job_id, purpose, operation, scheduled_at) VALUES ('existing-outbox', 'existing-job', 'diagnostics', 'initialize_do', 100);
      INSERT INTO diagnostic_requests (id, environment, actor_id, operation, idempotency_key, scenario, job_id, accepted_at) VALUES ('existing-request', 'test', 'existing-actor', 'start_check', 'existing-key', 'success', 'existing-job', 100);
      INSERT INTO diagnostic_checks (job_id, scenario, do_persistence, consumer_completion, dlq_receipt) VALUES ('existing-job', 'success', 'pending', 'pending', 'not_expected');
    `,
      ],
      { schemaDirectory: fixture },
    );
    await prepareMigrationFixture(fixture, '20261102101336_wide_zombie');
    for (const _ of Array(2).keys()) {
      await runDatabaseCommand(config, ['migrate'], { schemaDirectory: fixture });
      await runDatabaseCommand(
        config,
        [
          'execute',
          `
        CREATE TEMP TABLE retained (count INTEGER CHECK (count = 1));
        INSERT INTO retained SELECT COUNT(*) FROM jobs WHERE job_id = 'existing-job' AND accepted_at = 100;
        INSERT INTO retained SELECT COUNT(*) FROM job_outbox WHERE id = 'existing-outbox';
        INSERT INTO retained SELECT COUNT(*) FROM diagnostic_requests WHERE id = 'existing-request';
        INSERT INTO retained SELECT COUNT(*) FROM diagnostic_checks WHERE job_id = 'existing-job';
        CREATE TEMP TABLE migrations_applied (count INTEGER CHECK (count = 4));
        INSERT INTO migrations_applied SELECT COUNT(*) FROM _void_migrations;
        CREATE TEMP TABLE no_seed (count INTEGER CHECK (count = 0));
        INSERT INTO no_seed SELECT COUNT(*) FROM connection_checks;
        INSERT INTO no_seed SELECT COUNT(*) FROM pragma_foreign_key_check;
      `,
        ],
        { schemaDirectory: fixture },
      );
    }
  } finally {
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('失敗したmigrationは変更と履歴を残さず、修正後に再適用できる', async () => {
  const { prepareMigrationFixture } =
    await import('../../../packages/database/testing/database.ts');
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const fixture = join(config.artifactDirectory, 'migration-source');
  const options = { schemaDirectory: fixture };

  try {
    await prepareMigrationFixture(fixture, '20261102101336_wide_zombie');
    await runDatabaseCommand(config, ['migrate'], options);
    await runDatabaseCommand(
      config,
      [
        'execute',
        "INSERT INTO connection_checks (writer, value) VALUES ('migration-keep', 'original')",
      ],
      options,
    );
    const tag = '20990101000000_failure_fixture';
    const journalPath = join(fixture, 'migrations/meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.entries.push({ idx: 4, version: '6', when: 4070908800000, tag, breakpoints: true });
    await writeFile(journalPath, JSON.stringify(journal));
    const migration = join(fixture, 'migrations', `${tag}.sql`);
    await writeFile(
      migration,
      "-- void:allow-destructive\nCREATE TABLE failure_marker (id TEXT PRIMARY KEY); UPDATE connection_checks SET value = 'changed'; SELECT missing_column FROM connection_checks;",
    );
    await expect(runDatabaseCommand(config, ['migrate'], options)).rejects.toThrow(
      'DB migrate失敗',
    );
    expect(await readFile(join(config.artifactDirectory, 'db-migrate.log'), 'utf8')).toContain(
      'missing_column',
    );
    await runDatabaseCommand(
      config,
      [
        'execute',
        `
      CREATE TEMP TABLE failed_migration_count (count INTEGER CHECK (count = 0));
      INSERT INTO failed_migration_count SELECT COUNT(*) FROM _void_migrations WHERE name = '${tag}.sql';
      INSERT INTO failed_migration_count SELECT COUNT(*) FROM sqlite_master WHERE name = 'failure_marker';
      CREATE TEMP TABLE retained_value (count INTEGER CHECK (count = 1));
      INSERT INTO retained_value SELECT COUNT(*) FROM connection_checks WHERE writer = 'migration-keep' AND value = 'original';
    `,
      ],
      options,
    );
    await writeFile(migration, 'CREATE TABLE failure_marker (id TEXT PRIMARY KEY);');
    await runDatabaseCommand(config, ['migrate'], options);
    await runDatabaseCommand(config, ['migrate'], options);
    await runDatabaseCommand(
      config,
      [
        'execute',
        `
      CREATE TEMP TABLE repaired (count INTEGER CHECK (count = 1));
      INSERT INTO repaired SELECT COUNT(*) FROM _void_migrations WHERE name = '${tag}.sql';
      INSERT INTO repaired SELECT COUNT(*) FROM sqlite_master WHERE name = 'failure_marker';
      INSERT INTO repaired SELECT COUNT(*) FROM connection_checks WHERE writer = 'migration-keep' AND value = 'original';
    `,
      ],
      options,
    );
  } finally {
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);
