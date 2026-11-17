import { startRuntimeInProcess, PendingRuntimeCleanup } from './runtime.ts';
import type { LocalRuntime } from './runtime.ts';
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
    process.send?.(message, () => {
      /* この実装では追加の処理を行わない。 */
    });
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
  if (!isStartType(message.type) || startingContext.starting || startingContext.stopping) {
    return;
  }
  startingContext.starting = startRuntimeInProcess(
    message.config,
    message.mode,
    message.options,
    startup.signal,
  );
  void finishStart(startingContext.starting);
});

async function observeClosed(runtime: LocalRuntime): Promise<void> {
  try {
    const { exitCode } = await runtime.closed;
    if (exitCode !== 0 && !startingContext.stopping) {
      report('ローカルランタイムが予期せず終了しました。');
      stop();
    }
  } catch (error) {
    report(error instanceof Error ? error : 'ランタイムの終了確認に失敗しました。');
    stop();
  }
}
async function finishStart(starting: Promise<LocalRuntime>): Promise<void> {
  try {
    const runtime = await starting;
    void observeClosed(runtime);
    if (startingContext.stopping) {
      stop();
    } else {
      send({ type: 'ready', baseUrl: runtime.baseUrl });
    }
  } catch (error) {
    report(error instanceof Error ? error : 'ランタイムを起動できませんでした。');
    stop();
  }
}

function isStartType(type: string): boolean {
  return type === 'start';
}
