import type { ChildProcess } from 'node:child_process';

export const monotonicMilliseconds = () => Number(process.hrtime.bigint()) / 1e6;

export async function requestViteSnapshot(
  child: ChildProcess,
  start: number,
  url: number,
  end: number,
  signal?: AbortSignal,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const onMessage = (message: string) => {
    if (message === 'vite-startup-snapshot-saved') {
      resolve(true);
    }
  };
  const onExit = () => {
    reject(new Error('Vite計測の保存前にプロセスが終了しました。'));
  };
  const onError = (error: Error) => {
    reject(error);
  };
  const onAbort = () => {
    reject(new Error('Vite計測を中断しました。'));
  };
  const timer = setTimeout(() => {
    reject(new Error('Vite計測の保存がタイムアウトしました。'));
  }, 10_000);
  child.on('message', onMessage);
  child.once('exit', onExit);
  child.once('error', onError);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) {
      onAbort();
    } else if (child.exitCode !== null || child.signalCode !== null || !child.connected) {
      onExit();
    } else {
      child.send({ type: 'vite-startup-snapshot', start, url, end }, (error) => {
        if (error) {
          reject(error);
        }
      });
    }
    await promise;
  } finally {
    clearTimeout(timer);
    child.off('message', onMessage);
    child.off('exit', onExit);
    child.off('error', onError);
    signal?.removeEventListener('abort', onAbort);
  }
}
