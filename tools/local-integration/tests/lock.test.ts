import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, onTestFinished, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { claimArtifactDirectory } from '@korekaite/runtime-config/artifacts';
import { lockEnvironment } from '../src/lock.ts';

test('保持プロセスを強制終了すると環境ロックを再取得できる', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'korekaite-lock-'));
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: 'crash',
    parallelIndex: 0,
  });
  const moduleUrl = new URL('../src/lock.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { lockEnvironment } from ${JSON.stringify(moduleUrl)};
    const release = await lockEnvironment(${JSON.stringify(config)});
    process.send('locked');
    setInterval(() => void release, 1000);
  `,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
      child.once('exit', () => reject(new Error(stderr)));
    });
    await expect(lockEnvironment(config)).rejects.toThrow('環境は使用中です');
    child.kill('SIGKILL');
    await stopped;
    const release = await lockEnvironment(config);
    release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await stopped;
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}, 15_000);

test('本番環境ではローカル操作用のロックを作らない', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'korekaite-lock-'));
  onTestFinished(() => rm(repositoryRoot, { recursive: true, force: true }));
  const config = resolveRuntime({ repositoryRoot, appEnv: 'production' });
  await expect(lockEnvironment(config)).rejects.toThrow('ローカル環境だけを操作できます。');
});

test('ロックの解放を複数回呼んでも安全で再取得できる', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'korekaite-lock-'));
  onTestFinished(() => rm(repositoryRoot, { recursive: true, force: true }));
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: 'release',
    parallelIndex: 0,
  });
  const release = await lockEnvironment(config);
  release();
  expect(release).not.toThrow();
  const releaseAgain = await lockEnvironment(config);
  releaseAgain();
});

test('ロックDBを開けない場合は使用中と誤分類せず元のエラーを返す', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'korekaite-lock-'));
  onTestFinished(() => rm(repositoryRoot, { recursive: true, force: true }));
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: 'invalid-db',
    parallelIndex: 0,
  });
  await claimArtifactDirectory(config);
  await mkdir(join(config.artifactDirectory, 'operation-lock.sqlite'));
  await expect(lockEnvironment(config)).rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR' });
});
