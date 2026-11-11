import { SystemError } from '../../testing/system-error.mts';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { claimArtifactDirectory } from '@korekaite/runtime-config/artifacts';
import { runDatabaseCommand } from '../src/database.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, symlink: vi.fn(actual.symlink) };
});
afterEach(() => vi.resetAllMocks());

async function fixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'korekaite-db-errors-'));
  onTestFinished(() => rm(repositoryRoot, { recursive: true, force: true }));
  return {
    repositoryRoot,
    config: resolveRuntime({ repositoryRoot, appEnv: 'test', runId: 'guards', parallelIndex: 0 }),
  };
}

test('SQLではなくオプション形式の値を渡してもDBコマンドへ転送しない', async () => {
  const { config } = await fixture();
  await expect(runDatabaseCommand(config, ['execute', '--remote'])).rejects.toThrow(
    '未対応のDB操作です。',
  );
  expect(symlink).not.toHaveBeenCalled();
});

test('本番環境のDBへローカル管理コマンドを実行しない', async () => {
  const { repositoryRoot } = await fixture();
  const production = resolveRuntime({ repositoryRoot, appEnv: 'production' });
  await expect(runDatabaseCommand(production, ['migrate'])).rejects.toThrow(
    'ローカルDBだけを操作できます。',
  );
  expect(symlink).not.toHaveBeenCalled();
});

test('通常開発のDBへテスト用の履歴差し替えを持ち込まない', async () => {
  const { repositoryRoot } = await fixture();
  const config = resolveRuntime({ repositoryRoot, appEnv: 'development' });
  await expect(
    runDatabaseCommand(config, ['migrate'], {
      schemaDirectory: join(config.artifactDirectory, 'schema'),
    }),
  ).rejects.toThrow('履歴の差し替えは独立テスト環境のmigration検証だけで利用できます。');
  expect(symlink).not.toHaveBeenCalled();
});

test('DB管理用の依存参照が別のディレクトリを向いていれば実行しない', async () => {
  const { config, repositoryRoot } = await fixture();
  await claimArtifactDirectory(config);
  const project = join(config.artifactDirectory, 'database');
  await mkdir(project);
  await symlink(repositoryRoot, join(project, 'node_modules'));
  await expect(runDatabaseCommand(config, ['migrate'])).rejects.toThrow(
    'DB管理用の参照先が一致しません。',
  );
});

test('DB管理用リンクの作成失敗を既存リンクの競合と誤分類しない', async () => {
  const { config } = await fixture();
  const failure = new SystemError('fixture permission error', 'EACCES');
  vi.mocked(symlink).mockRejectedValueOnce(failure);
  await expect(runDatabaseCommand(config, ['migrate'])).rejects.toBe(failure);
});
