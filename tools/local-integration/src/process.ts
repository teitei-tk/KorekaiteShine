import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** ローカルのNode CLIを期限付きで実行し、子孫停止とログ保存までを完了条件にする。 */
export async function runNodeCommand(input: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const aborted = () =>
    new Error(`${input.label}を中断しました。${input.logPath}を確認してください。`);
  if (input.signal?.aborted) {
    throw aborted();
  }
  const child = spawn(process.execPath, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Promiseのexecutorで同期的に設定し、finallyで同じリスナーを解除する。
  let onAbort!: () => void;
  try {
    const code = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(aborted());
        input.signal?.addEventListener('abort', onAbort, { once: true });
        if (input.signal?.aborted) {
          onAbort();
        }
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${input.label}がタイムアウトしました。${input.logPath}を確認してください。`,
              ),
            ),
          input.timeoutMs,
        );
      }),
    ]);
    if (code !== 0) {
      throw new Error(`${input.label}失敗（${code}）。${input.logPath}を確認してください。`);
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
    try {
      await stopProcessGroup(child);
      await closed;
    } finally {
      await writeFile(input.logPath, output);
    }
  }
}

/** detachedで起動した、自分が所有するプロセスグループだけを停止する。 */
export async function stopProcessGroup(
  child: ChildProcess,
  { graceMs = 5000, killMs = 5000 }: { graceMs?: number; killMs?: number } = {},
): Promise<void> {
  if (!child.pid) {
    return;
  }
  const group = -child.pid;
  function signal(value: NodeJS.Signals | 0): boolean {
    try {
      process.kill(group, value);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return false;
      }
      // 生存確認の拒否では終了済みと判定できない。期限まで確認を続ける。
      if (value === 0 && error instanceof Error && 'code' in error && error.code === 'EPERM') {
        return true;
      }
      throw error;
    }
  }
  async function waitUntilGone(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (signal(0)) {
      if (performance.now() >= deadline) {
        return false;
      }
      await delay(25);
    }
    return true;
  }
  if (!signal('SIGTERM') || (await waitUntilGone(graceMs))) {
    return;
  }
  if (!signal('SIGKILL') || (await waitUntilGone(killMs))) {
    return;
  }
  throw new Error('ローカルプロセスを期限内に停止できませんでした。');
}
