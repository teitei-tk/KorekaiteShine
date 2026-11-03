import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from '@korekaite/runtime-config';
import { runDatabaseCommand } from './database.ts';
import { lockEnvironment } from './lock.ts';
import { readDevelopmentSnapshot } from './development-snapshot.ts';

async function main() {
  if (process.argv.length !== 2) {
    throw new Error('追加引数は受け付けません。');
  }
  const config = resolveRuntime({
    repositoryRoot: fileURLToPath(new URL('../../../', import.meta.url)),
    appEnv: 'development',
  });
  const release = await lockEnvironment(config);
  try {
    await runDatabaseCommand(config, ['migrate']);
    await runDatabaseCommand(config, [
      'execute',
      "INSERT INTO connection_checks (writer, value) VALUES ('integration-isolation-sentinel', 'retained-v1') ON CONFLICT DO NOTHING;",
    ]);
    const output = join(config.artifactDirectory, 'isolation-output.txt');
    try {
      await writeFile(output, 'development-retained-v1', { flag: 'wx' });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }
    }
    assert.ok(
      (await readFile(output, 'utf8')) === 'development-retained-v1',
      '保持確認用の出力が想定値と異なります。',
    );
    await readDevelopmentSnapshot(config);
    console.log('開発DBをリセットせず、統合検査の保持確認行を準備しました。');
  } finally {
    release();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
