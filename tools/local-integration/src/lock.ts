import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { RuntimeConfig } from '@korekaite/runtime-config';
import { claimArtifactDirectory } from '@korekaite/runtime-config/artifacts';

/** ローカル操作の排他専用。アプリのD1とは別のファイルでOSのロックを保持する。 */
export async function lockEnvironment(config: RuntimeConfig): Promise<() => void> {
  if (config.environment === 'production' || !config.stateDirectory) {
    throw new Error('ローカル環境だけを操作できます。');
  }
  await claimArtifactDirectory(config);
  let lock: DatabaseSync | undefined;
  try {
    lock = new DatabaseSync(join(config.artifactDirectory, 'operation-lock.sqlite'), {
      timeout: 0,
    });
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock?.close();
    if (error instanceof Error && error.message.includes('database is locked')) {
      throw new Error('環境は使用中です。ローカルランタイムと同じ環境の操作を停止してください。');
    }
    throw error;
  }
  // 接続終了・プロセス終了でロックが解放される。PIDファイルの手動削除は不要。
  return () => {
    if (lock?.isOpen) {
      lock.close();
    }
  };
}
