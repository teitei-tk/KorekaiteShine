import { mkdtemp, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, onTestFinished, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import {
  readDevelopmentSnapshot,
  readDevelopmentArtifactState,
} from '../src/development-snapshot.ts';

async function fixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'korekaite-dev-snapshot-'));
  onTestFinished(() => rm(repositoryRoot, { recursive: true, force: true }));
  return resolveRuntime({ repositoryRoot, appEnv: 'development' });
}

test('開発DBの保存先が未準備なら保持確認を成功扱いしない', async () => {
  await expect(readDevelopmentSnapshot(await fixture())).rejects.toThrow(
    '保持確認用DBが未準備です。pnpm prepare:integrationを実行してください。',
  );
});

test('別用途のSQLiteファイルを除外し実スキーマの開発DBだけを読み取る', async () => {
  const config = await fixture();
  await mkdir(config.stateDirectory!, { recursive: true });
  new DatabaseSync(join(config.stateDirectory!, 'unrelated.sqlite')).close();
  const database = new DatabaseSync(join(config.stateDirectory!, 'application.sqlite'));
  try {
    const migrations = new URL('../../../packages/database/db/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
      database.exec(await readFile(new URL(name, migrations), 'utf8'));
    }
    database
      .prepare('INSERT INTO connection_checks (writer, value) VALUES (?, ?)')
      .run('integration-isolation-sentinel', 'retained-v1');
  } finally {
    database.close();
  }
  const snapshot = await readDevelopmentSnapshot(config);
  expect(snapshot.sentinelCount).toBe(1);
  expect(snapshot.sentinelMatches).toBe(true);
  expect(snapshot.tables.connection_checks.count).toBe(1);
  expect(snapshot.tables.jobs.count).toBe(0);
  expect(Object.keys(snapshot.tables)).toHaveLength(10);
});

test('成果物の参照異常をファイル不在として隠さない', async () => {
  const config = await fixture();
  const directory = join(config.artifactDirectory, 'web');
  await mkdir(directory, { recursive: true });
  await symlink('vite.config.ts', join(directory, 'vite.config.ts'));
  await expect(readDevelopmentArtifactState(config)).rejects.toMatchObject({ code: 'ELOOP' });
});
