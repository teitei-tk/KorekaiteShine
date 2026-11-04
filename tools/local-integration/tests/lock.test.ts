import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
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
