import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeConfig } from './resources.ts';

export async function claimArtifactDirectory(runtime: RuntimeConfig): Promise<string> {
  await mkdir(runtime.artifactDirectory, { recursive: true });
  const path = join(runtime.artifactDirectory, 'runtime-identity.json');
  const identity = `${JSON.stringify(runtime, null, 2)}\n`;
  try {
    await writeFile(path, identity, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    if ((await readFile(path, 'utf8')) !== identity) {
      throw new Error('別環境または古い接続設定の生成物を再利用できません。');
    }
  }
  return runtime.artifactDirectory;
}
