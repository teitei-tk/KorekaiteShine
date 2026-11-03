import { startRuntimeInProcess, PendingRuntimeCleanup, type LocalRuntime } from './runtime.ts';
import type { RuntimeOwnerMessage, RuntimeOwnerRequest } from './runtime-owner.ts';

let starting: Promise<LocalRuntime> | undefined;
let stopping = false;
let cleanup: Promise<void> | undefined;
let pendingCleanup: (() => Promise<void>) | undefined;
const startup = new AbortController();

function send(message: RuntimeOwnerMessage): void {
  if (process.connected) process.send?.(message, () => {});
}

function report(error: Error | string): void {
  process.exitCode = 1;
  send({ type: 'error', message: error instanceof Error ? error.message : error });
}

function stop(): void {
  stopping = true;
  startup.abort();
  if (cleanup) return;
  cleanup = (async () => {
    const runtime = await starting?.catch((error) => {
      if (error instanceof PendingRuntimeCleanup) pendingCleanup = error.cleanup;
      return undefined;
    });
    if (runtime) await runtime.stop();
    if (pendingCleanup) {
      await pendingCleanup();
      pendingCleanup = undefined;
    }
    if (process.connected) process.disconnect?.();
  })().catch((error) => {
    report(error instanceof Error ? error : 'ランタイム停止の確認に失敗しました。');
    // 停止を確認できない間は所有者とロックを残し、再取得による二重起動を防ぐ。
    cleanup = undefined;
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
  if (message.type !== 'start' || starting || stopping) return;
  starting = startRuntimeInProcess(message.config, message.mode, message.options, startup.signal);
  starting.then(
    (runtime) => {
      void runtime.closed.then(({ exitCode }) => {
        if (exitCode !== 0 && !stopping) {
          report('ローカルランタイムが予期せず終了しました。');
          stop();
        }
      });
      if (stopping) stop();
      else send({ type: 'ready', baseUrl: runtime.baseUrl });
    },
    (error) => {
      report(error instanceof Error ? error : 'ランタイムを起動できませんでした。');
      stop();
    },
  );
});
