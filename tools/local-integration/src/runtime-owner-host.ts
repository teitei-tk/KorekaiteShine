import { startRuntimeInProcess, PendingRuntimeCleanup, type LocalRuntime } from './runtime.ts';
import type { RuntimeOwnerMessage, RuntimeOwnerRequest } from './runtime-owner.ts';

const startingContext = {
  starting: undefined as Promise<LocalRuntime> | undefined,
  stopping: false,
  cleanup: undefined as Promise<void> | undefined,
  pendingCleanup: undefined as (() => Promise<void>) | undefined,
};
const startup = new AbortController();

function send(message: RuntimeOwnerMessage): void {
  if (process.connected) {
    process.send?.(message, () => {});
  }
}

function report(error: Error | string): void {
  process.exitCode = 1;
  send({ type: 'error', message: error instanceof Error ? error.message : error });
}

function stop(): void {
  startingContext.stopping = true;
  startup.abort();
  if (startingContext.cleanup) {
    return;
  }
  startingContext.cleanup = (async () => {
    const runtime = await startingContext.starting?.catch((error) => {
      if (error instanceof PendingRuntimeCleanup) {
        startingContext.pendingCleanup = error.cleanup;
      }
      return undefined;
    });
    if (runtime) {
      await runtime.stop();
    }
    if (startingContext.pendingCleanup) {
      await startingContext.pendingCleanup();
      startingContext.pendingCleanup = undefined;
    }
    if (process.connected) {
      process.disconnect?.();
    }
  })().catch((error) => {
    report(error instanceof Error ? error : 'ランタイム停止の確認に失敗しました。');
    // 停止を確認できない間は所有者とロックを残し、再取得による二重起動を防ぐ。
    startingContext.cleanup = undefined;
    setTimeout(stop, 1000);
  });
}

process.once('disconnect', stop);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.on('message', (message: RuntimeOwnerRequest) => {
  if (message.type === 'stop') {
    stop();
    return;
  }
  if (message.type !== 'start' || startingContext.starting || startingContext.stopping) {
    return;
  }
  startingContext.starting = startRuntimeInProcess(
    message.config,
    message.mode,
    message.options,
    startup.signal,
  );
  startingContext.starting.then(
    (runtime) => {
      void runtime.closed.then(({ exitCode }) => {
        if (exitCode !== 0 && !startingContext.stopping) {
          report('ローカルランタイムが予期せず終了しました。');
          stop();
        }
      });
      if (startingContext.stopping) {
        stop();
      } else {
        send({ type: 'ready', baseUrl: runtime.baseUrl });
      }
    },
    (error) => {
      report(error instanceof Error ? error : 'ランタイムを起動できませんでした。');
      stop();
    },
  );
});
