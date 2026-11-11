import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { lockEnvironment } from '../src/lock.ts';

async function processTable() {
  const { stdout } = await promisify(execFile)('ps', ['-eo', 'pid=,ppid=,pgid=,stat='], {
    timeout: 5000,
  });
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, parent, group, state] = line.trim().split(/\s+/u);
      return { pid: Number(pid), parent: Number(parent), group: Number(group), state: state! };
    });
}

function killOwned(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

test('起動元をSIGKILLしても子ランタイムを停止し、その終了前に環境ロックを解放しない', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'korekaite-owner-'));
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: 'parent-death',
    parallelIndex: 0,
  });
  const moduleUrl = new URL('../src/runtime.ts', import.meta.url).href;
  const launcher = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { startRuntime } from ${JSON.stringify(moduleUrl)};
    const runtime = await startRuntime(${JSON.stringify(config)});
    process.send({ baseUrl: runtime.baseUrl });
  `,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  launcher.stderr!.resume();
  const exited = new Promise<void>((resolve) => launcher.once('exit', () => resolve()));
  const descendants = new Set<number>();
  const groups = new Set<number>();

  try {
    await Promise.race([
      once(launcher, 'message', { signal: AbortSignal.timeout(60_000) }),
      exited.then(() => {
        throw new Error('起動確認前に起動元が終了しました。');
      }),
    ]);
    const rows = await processTable();
    const tree = new Set([launcher.pid!]);
    while (true) {
      const previous = tree.size;
      for (const row of rows) {
        if (tree.has(row.parent)) {
          tree.add(row.pid);
        }
      }
      if (tree.size === previous) {
        break;
      }
    }
    for (const row of rows) {
      if (row.pid === launcher.pid || !tree.has(row.pid)) {
        continue;
      }
      descendants.add(row.pid);
      if (row.pid === row.group) {
        groups.add(row.group);
      }
    }
    expect(groups.size).toBeGreaterThan(0);
    await expect(lockEnvironment(config)).rejects.toThrow('環境は使用中です');
    launcher.kill('SIGKILL');
    await exited;
    const deadline = performance.now() + 15_000;
    for (;;) {
      const releaseState = { release: undefined as (() => void) | undefined };
      try {
        releaseState.release = await lockEnvironment(config);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes('環境は使用中です'))) {
          throw error;
        }
      }
      if (releaseState.release) {
        try {
          const alive = (await processTable()).filter(
            (row) => groups.has(row.group) && !row.state.startsWith('Z'),
          );
          expect(alive, '子ランタイムが動いている間は環境を再取得できません').toEqual([]);
        } finally {
          releaseState.release();
        }
        break;
      }
      expect(performance.now(), '停止後に環境ロックを再取得できません').toBeLessThan(deadline);
      await delay(50);
    }
    await expect
      .poll(
        async () =>
          (await processTable()).filter(
            (row) => descendants.has(row.pid) && !row.state.startsWith('Z'),
          ),
        { timeout: 10_000 },
      )
      .toEqual([]);
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill('SIGKILL');
    }
    await exited;
    for (const group of groups) {
      killOwned(-group);
    }
    for (const row of await processTable()) {
      if (descendants.has(row.pid) && !row.state.startsWith('Z')) {
        killOwned(row.pid);
      }
    }
  }

  await rm(repositoryRoot, { recursive: true, force: true });
}, 90_000);

test('Viteの異常終了を起動CLIへ伝え、残りの子プロセスとロックを解放して失敗終了する', async () => {
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const runId = randomUUID();
  const config = resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex: 0 });
  const launcher = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/run.ts', import.meta.url)), 'dev'],
    {
      env: { ...process.env, APP_ENV: 'test', LOCAL_TEST_RUN_ID: runId, LOCAL_TEST_SLOT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const outputContext = { output: '', errors: '' };
  launcher.stdout.on('data', (chunk: Buffer) => {
    outputContext.output += chunk.toString();
  });
  launcher.stderr.on('data', (chunk: Buffer) => {
    outputContext.errors += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) =>
    launcher.once('exit', (code) => resolve(code)),
  );
  const descendants = new Set<number>();
  const groups = new Set<number>();

  try {
    await expect
      .poll(() => outputContext.output.includes('ローカルWeb: http://127.0.0.1:'), {
        timeout: 60_000,
      })
      .toBe(true);
    const rows = await processTable();
    const tree = new Set([launcher.pid!]);
    while (true) {
      const previous = tree.size;
      for (const row of rows) {
        if (tree.has(row.parent)) {
          tree.add(row.pid);
        }
      }
      if (tree.size === previous) {
        break;
      }
    }
    for (const row of rows) {
      if (row.pid === launcher.pid || !tree.has(row.pid)) {
        continue;
      }
      descendants.add(row.pid);
      if (row.pid === row.group) {
        groups.add(row.group);
      }
    }
    expect(groups.size).toBeGreaterThan(0);
    await expect(lockEnvironment(config)).rejects.toThrow('環境は使用中です');
    // グループ全体ではなくViteだけを落とし、残ったworkerdの停止を管理側へ任せる。
    killOwned([...groups][0]!);
    await expect.poll(() => launcher.exitCode, { timeout: 15_000 }).toBe(1);
    expect(await exited).toBe(1);
    expect(outputContext.errors).toContain('予期せず終了');
    await expect
      .poll(
        async () =>
          (await processTable()).filter(
            (row) => descendants.has(row.pid) && !row.state.startsWith('Z'),
          ),
        { timeout: 10_000 },
      )
      .toEqual([]);
    const release = await lockEnvironment(config);
    release();
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill('SIGKILL');
    }
    await exited;
    for (const group of groups) {
      killOwned(-group);
    }
    for (const row of await processTable()) {
      if (descendants.has(row.pid) && !row.state.startsWith('Z')) {
        killOwned(row.pid);
      }
    }
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 90_000);
