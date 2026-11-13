import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { stopProcessGroup, runNodeCommand } from '../src/process.ts';

test('終了要求を無視する子プロセスを猶予後に強制停止する', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    process.stdout.write('ready');
  `,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    const started = performance.now();
    await stopProcessGroup(child, { graceMs: 100, killMs: 2000 });
    expect(performance.now() - started).toBeLessThan(2500);
    expect(await exited).toEqual([null, 'SIGKILL']);
    expect(() => process.kill(-child.pid!, 0)).toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
      await exited;
    }
  }
}, 5000);

test('終了しないローカルコマンドを期限で停止し、停止確認後にログ付きで失敗を返す', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'korekaite-command-'));
  const logPath = join(directory, 'command.log');
  try {
    await expect(
      runNodeCommand({
        args: [
          '-e',
          `
        process.on('SIGTERM', () => {});
        console.log(process.pid);
        setInterval(() => {}, 1000);
      `,
        ],
        cwd: directory,
        env: process.env,
        logPath,
        label: '期限検証',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('タイムアウト');
    const pid = Number((await readFile(logPath, 'utf8')).trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(-pid, 0)).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('実行中の子コマンドへ中断を伝え、期限を待たず停止確認して戻る', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'korekaite-abort-'));
  const pidPath = join(directory, 'pid');
  const controller = new AbortController();
  const settledContext = { settled: false, pid: 0 };
  const running = runNodeCommand({
    args: [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
    ],
    cwd: directory,
    env: process.env,
    logPath: join(directory, 'command.log'),
    label: '中断検証',
    timeoutMs: 30_000,
    signal: controller.signal,
  }).then(
    () => {
      settledContext.settled = true;
      return '';
    },
    (error: Error) => {
      settledContext.settled = true;
      return error.message;
    },
  );
  try {
    await expect
      .poll(async () => readFile(pidPath, 'utf8').catch(() => ''), { timeout: 5000 })
      .toMatch(/^\d+$/u);
    settledContext.pid = Number(await readFile(pidPath, 'utf8'));
    controller.abort(new Error('private-abort-reason'));
    await expect.poll(() => settledContext.settled, { timeout: 3000 }).toBe(true);
    const message = await running;
    expect(message).toContain('中断');
    expect(message).not.toContain('private-abort-reason');
    const codeState = { code: '' };
    try {
      process.kill(-settledContext.pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        codeState.code = String(error.code);
      }
    }
    expect(codeState.code).toBe('ESRCH');
  } finally {
    controller.abort();
    if (settledContext.pid > 0) {
      try {
        process.kill(-settledContext.pid, 'SIGKILL');
      } catch {
        /* 停止確認済みの場合は対象がない。 */
      }
    }
    await running;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
