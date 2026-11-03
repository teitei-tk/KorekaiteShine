import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveRuntime } from '@korekaite/runtime-config';
import { runDatabaseCommand } from '../src/database.ts';
import { expect, test } from 'vitest';
import {
  buildProductionArtifacts,
  runProductionBuild,
  startProductionPreview,
  verifyProductionArtifacts,
} from '../src/production.ts';

test('本番ビルドの4環境のモジュール・ルート・配信物・Worker設定に診断を含めない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'korekaite-production-'));
  let succeeded = false;
  try {
    const project = await buildProductionArtifacts(directory);
    const report = await verifyProductionArtifacts(project);
    expect(report.environments.sort()).toEqual(['client', 'evaluation', 'interview', 'ssr']);
    expect(report.routes.sort()).toEqual(['__root.tsx', 'api.interviews.ts', 'index.tsx']);
    const config = JSON.parse(await readFile(join(project, 'dist/server/wrangler.json'), 'utf8'));
    expect(config.vars.APP_ENV).toBe('production');
    expect(config.name).toBe('korekaite-web-prod');
    succeeded = true;
  } finally {
    if (succeeded) await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test('監査記録にない配信ファイルを後から追加した場合も拒否する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'korekaite-production-extra-'));
  let succeeded = false;
  try {
    const project = await buildProductionArtifacts(directory);
    const extra = join(project, 'dist/client/extra');
    await mkdir(extra);
    await writeFile(join(extra, 'diagnostics.js'), 'export const scenario = "exhaust_retries";');
    await expect(verifyProductionArtifacts(project)).rejects.toThrow('未記録の本番配信物');
    succeeded = true;
  } finally {
    if (succeeded) await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test('本番ビルドの診断HTTPは404で、受付・outbox・確認結果を作らない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'korekaite-production-http-'));
  let succeeded = false;
  try {
    const project = await buildProductionArtifacts(directory);
    // 本番識別子を使うビルドの検査用。接続先はこの一時ディレクトリのローカルSQLiteのみ。
    const db = {
      ...resolveRuntime({
        repositoryRoot: directory,
        appEnv: 'test',
        runId: randomUUID(),
        parallelIndex: 0,
      }),
      d1: resolveRuntime({ repositoryRoot: directory, appEnv: 'production' }).d1,
      stateDirectory: join(directory, 'preview-state'),
      artifactDirectory: join(directory, 'database-audit'),
    };
    await runDatabaseCommand(db, ['migrate']);
    await runDatabaseCommand(db, [
      'execute',
      "INSERT INTO connection_checks (writer, value) VALUES ('preserve', 'original')",
    ]);
    const runtime = await startProductionPreview(project);
    try {
      for (const path of [
        '/diagnostics',
        '/api/diagnostics/check-jobs',
        `/api/diagnostics/check-jobs/${randomUUID()}`,
      ]) {
        const response = await fetch(`${runtime.baseUrl}${path}`);
        expect(response.status, path).toBe(404);
        await response.text();
      }
      for (const scenario of ['success', 'retry_then_success', 'exhaust_retries']) {
        const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ scenario }),
        });
        expect(response.status, scenario).toBe(404);
        await response.text();
      }
      await runDatabaseCommand(db, [
        'execute',
        `
        CREATE TEMP TABLE untouched (count INTEGER CHECK (count = 0));
        INSERT INTO untouched SELECT COUNT(*) FROM jobs;
        INSERT INTO untouched SELECT COUNT(*) FROM job_outbox;
        INSERT INTO untouched SELECT COUNT(*) FROM diagnostic_requests;
        INSERT INTO untouched SELECT COUNT(*) FROM diagnostic_checks;
        INSERT INTO untouched SELECT COUNT(*) FROM dlq_receipts;
        INSERT INTO untouched SELECT COUNT(*) FROM delivery_anomalies;
        CREATE TEMP TABLE preserved (count INTEGER CHECK (count = 1));
        INSERT INTO preserved SELECT COUNT(*) FROM connection_checks;
        INSERT INTO preserved SELECT COUNT(*) FROM connection_checks WHERE writer = 'preserve' AND value = 'original';
      `,
      ]);
      const web = JSON.parse(await readFile(join(project, 'dist/server/wrangler.json'), 'utf8'));
      // HTTP入口にDO・他Worker・Queueの呼出し能力がないことも、実際の配置設定で確認する。
      expect(web.durable_objects.bindings).toEqual([]);
      expect(web.services).toEqual([]);
      expect(web.queues.producers).toEqual([]);
      expect(web.queues.consumers).toEqual([]);
    } finally {
      await runtime.stop();
    }
    succeeded = true;
  } finally {
    if (succeeded) await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test('3 Workersの本番入口へ診断importを混入させると、未使用でも検査が拒否する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'korekaite-production-mutation-'));
  let succeeded = false;
  try {
    const project = await buildProductionArtifacts(directory);
    await verifyProductionArtifacts(project);
    const diagnostic = fileURLToPath(
      new URL('../../../apps/evaluation/src/diagnostics/evaluator.ts', import.meta.url),
    );
    for (const entry of [
      'src/routes/index.tsx',
      'interview.production.ts',
      'evaluation.production.ts',
    ]) {
      const path = join(project, entry);
      const original = await readFile(path, 'utf8');
      try {
        await writeFile(path, `${original}\nimport ${JSON.stringify(diagnostic)};\n`);
        await runProductionBuild(project);
        await expect(verifyProductionArtifacts(project), entry).rejects.toThrow(
          '本番モジュールへ診断・検証コードが混入',
        );
      } finally {
        await writeFile(path, original);
      }
    }
    succeeded = true;
  } finally {
    if (succeeded) await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
