import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimeConfig } from '@korekaite/runtime-config';

/** 保持確認だけに使用する。DBファイル名の内部ハッシュを計算せず、スキーマで一意に照合する。 */
export async function readDevelopmentSnapshot(config: RuntimeConfig) {
  assert.equal(config.environment, 'development');
  assert.ok(config.stateDirectory);
  const candidates: string[] = [];
  const files = await readdir(config.stateDirectory, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => {
    throw new Error('保持確認用DBが未準備です。pnpm prepare:integrationを実行してください。');
  });
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.sqlite')) continue;
    const path = join(file.parentPath, file.name);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('jobs', 'diagnostic_requests', 'connection_checks')",
        )
        .get();
      if (row?.count === 3) candidates.push(path);
    } finally {
      database.close();
    }
  }
  assert.equal(
    candidates.length,
    1,
    '保持確認用のローカルD1を一意に特定できません。pnpm prepare:integrationを確認してください。',
  );
  const database = new DatabaseSync(candidates[0]!, { readOnly: true });
  try {
    database.exec('BEGIN');
    const tables: Record<string, { count: number; sha256: string }> = {};
    for (const table of [
      'connection_checks',
      'jobs',
      'job_outbox',
      'execution_slots',
      'job_attempts',
      'delivery_anomalies',
      'deleted_jobs',
      'dlq_receipts',
      'diagnostic_requests',
      'diagnostic_checks',
    ]) {
      const rows = database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      tables[table] = {
        count: rows.length,
        sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      };
    }
    const sentinel = database
      .prepare(
        "SELECT value FROM connection_checks WHERE writer = 'integration-isolation-sentinel'",
      )
      .all();
    assert.equal(
      sentinel.length,
      1,
      '保持確認行が未準備です。pnpm prepare:integrationを実行してください。',
    );
    assert.ok(
      sentinel[0]?.value === 'retained-v1',
      '保持確認行が想定値と異なるため上書きしません。',
    );
    return {
      tables,
      sentinelCount: sentinel.length,
      sentinelMatches: sentinel[0]?.value === 'retained-v1',
    };
  } finally {
    database.close();
  }
}

export async function readDevelopmentArtifactState(config: RuntimeConfig) {
  assert.equal(config.environment, 'development');
  return Promise.all(
    ['web/vite.config.ts', 'runtime.log', 'database/.void/local-d1.json'].map(async (path) => {
      try {
        const result = await stat(join(config.artifactDirectory, path));
        return { path, mtimeMs: result.mtimeMs, size: result.size };
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          return { path, mtimeMs: null, size: null };
        throw error;
      }
    }),
  );
}
