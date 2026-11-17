import { parseJson } from '@korekaite/api-contracts/json';
import { isObject } from './records.ts';
import { requireValue } from './required.ts';
import {
  coverageEnvironment,
  localProcessEnvironment,
  localAiEnvironment,
} from './local-environment.ts';
import { fork } from 'node:child_process';
import type { RuntimeConfig } from '@korekaite/runtime-config';
import type { LocalRuntime, LocalRuntimeOptions } from './runtime.ts';

export type RuntimeOwnerRequest =
  | { type: 'start'; config: RuntimeConfig; mode: 'dev' | 'preview'; options: LocalRuntimeOptions }
  | { type: 'stop' };
export type RuntimeOwnerMessage =
  | { type: 'ready'; baseUrl: string }
  | { type: 'error'; message: string };

async function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  const timerState = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timerState.timer = setTimeout(() => {
          reject(new Error(message));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timerState.timer);
  }
}

export function connectLocalRuntime(
  baseUrl: string,
  stop: () => Promise<void>,
  evaluationWorker: string,
  closed: Promise<{ exitCode: 0 | 1 }>,
): LocalRuntime {
  return {
    baseUrl,
    closed,
    stop,
    async runScheduled(signal) {
      const url = new URL('/cdn-cgi/local/explorer/api/local/scheduled', baseUrl);
      url.searchParams.set('worker', evaluationWorker);
      const response = await fetch(url, {
        signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cron: '* * * * *' }),
      });
      const body = parseJson(await response.text());
      if (
        !response.ok ||
        !isObject(body) ||
        !isObject(body.result) ||
        body.result.outcome !== 'ok'
      ) {
        throw new Error(`scheduledイベント失敗: ${JSON.stringify(body)}`);
      }
    },
  };
}

/** ロックと子プロセスはIPCの相手が終了しても生存する所有者へまとめる。 */
export async function startOwnedRuntime(
  config: RuntimeConfig,
  mode: 'dev' | 'preview',
  options: LocalRuntimeOptions,
): Promise<LocalRuntime> {
  const owner = fork(new URL('runtime-owner-host.ts', import.meta.url), [], {
    execArgv: [],
    env: {
      ...localProcessEnvironment(),
      ...coverageEnvironment(config.environment),
      ...localAiEnvironment(config.environment, mode),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  requireValue(owner.stderr).resume();
  const failureState = { failure: undefined as string | undefined };
  const closed = new Promise<number | null>((resolve) => {
    owner.once('close', (code) => {
      resolve(code);
    });
  });
  const ready = new Promise<string>((resolve, reject) => {
    // eslint-disable-next-line typescript/no-restricted-types -- IPC境界で通知の形状を検証する。
    owner.on('message', (message: unknown) => {
      if (isObject(message) && message.type === 'ready' && typeof message.baseUrl === 'string') {
        resolve(message.baseUrl);
      } else if (
        isObject(message) &&
        message.type === 'error' &&
        typeof message.message === 'string'
      ) {
        failureState.failure = message.message;
        reject(new Error(message.message));
      }
    });
    owner.once('error', reject);
    owner.once('close', (code) => {
      reject(
        new Error(
          failureState.failure ?? `ランタイム管理プロセスが起動前に終了しました（${code}）。`,
        ),
      );
    });
    const request: RuntimeOwnerRequest = { type: 'start', config, mode, options };
    owner.send(request, (error) => {
      if (error) {
        reject(error);
      }
    });
  });
  const stoppingState = { stopping: undefined as Promise<void> | undefined };
  function stop(): Promise<void> {
    return (stoppingState.stopping ??= (async () => {
      if (owner.connected) {
        const request: RuntimeOwnerRequest = { type: 'stop' };
        owner.send(request, () => {
          /* この実装では追加の処理を行わない。 */
        });
      }
      const code = await within(
        closed,
        15_000,
        'ランタイムの停止確認が期限を超えました。管理プロセスで後処理を継続しています。',
      );
      if (code !== 0) {
        throw new Error(
          failureState.failure ?? `ランタイム管理プロセスが異常終了しました（${code}）。`,
        );
      }
    })());
  }
  try {
    const baseUrl = await within(ready, 120_000, 'ランタイム起動が120秒以内に完了しませんでした。');
    const completion = closed.then((code): { exitCode: 0 | 1 } => ({
      exitCode: code === 0 && stoppingState.stopping !== undefined ? 0 : 1,
    }));
    return connectLocalRuntime(baseUrl, stop, config.workers.evaluation, completion);
  } catch (error) {
    await stop().catch(() => {
      /* この実装では追加の処理を行わない。 */
    });
    throw error;
  }
}
