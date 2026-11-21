import { requireValue } from './required.ts';
import { readFile } from 'node:fs/promises';
import { startVoiceRuntime } from '../runtime.mjs';
import { fixtureSql, parseFixtures } from './fixtures.ts';
// 親が所有するプロセスグループで動かす。停止信号は既存のWorker所有者にも届く。
const startup = Promise.withResolvers<Awaited<ReturnType<typeof startVoiceRuntime>>>();
const state = {
  starting: startup.promise,
  stopping: false,
  cleanup: undefined as Promise<void> | undefined,
};
const isStopping = () => state.stopping;
const shutdown = new AbortController();
function stop(): Promise<void> {
  state.stopping = true;
  shutdown.abort();
  return (state.cleanup ??= (async () => {
    try {
      const runtime = await state.starting.catch(() => undefined);
      await runtime?.stop();
    } catch {
      process.exitCode = 1;
    } finally {
      if (process.connected) {
        process.disconnect?.();
      }
    }
  })());
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
process.once('disconnect', () => {
  void stop();
});
async function start() {
  const fixture = parseFixtures(await readFile(requireValue(process.argv[2]), 'utf8'));
  const runtime = await startVoiceRuntime({ profile: 'pr', signal: shutdown.signal });
  try {
    if (!isStopping()) {
      await runtime.executeTestSql(fixtureSql(fixture), shutdown.signal);
      if (!isStopping() && process.connected) {
        if (typeof runtime.url !== 'string') {
          throw new TypeError('ランタイムURLが不正です。');
        }
        process.send?.({ type: 'ready', url: runtime.url });
      }
    }
    return runtime;
  } catch (error) {
    await runtime.stop();
    throw error;
  }
}
try {
  startup.resolve(await start());
} catch (error) {
  startup.reject(error);
  process.exitCode = 1;
  if (process.connected) {
    process.send?.({ type: 'error' });
  }
  await stop();
}
