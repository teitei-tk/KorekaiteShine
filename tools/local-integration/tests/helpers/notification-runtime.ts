import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime, type RuntimeConfig } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand, type LocalRuntime } from '../../src/runtime.ts';

interface NotificationCase {
  config: RuntimeConfig;
  runtime: LocalRuntime;
  newJobId(): string;
}

// 通知時刻の検査専用。同じWorkerを使い、各ケースの行だけを除去する。
export function createNotificationRuntime() {
  const config = resolveRuntime({
    repositoryRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  let runtime: LocalRuntime | undefined;
  let startup: Promise<LocalRuntime> | undefined;
  let state: 'new' | 'starting' | 'ready' | 'running' | 'failed' | 'closed' = 'new';
  let stopping: Promise<void> | undefined;
  return {
    async start() {
      if (state !== 'new') {
        throw new Error('通知検査の環境は一度だけ起動できます。');
      }
      state = 'starting';
      try {
        runtime = await (startup = startRuntime(config, 'dev', {
          manualDiagnostics: true,
          probeOnlyEvaluation: true,
        }));
        if (stopping) {
          throw new Error('通知検査の起動中に停止されました。');
        }
        state = 'ready';
      } catch (error) {
        state = 'failed';
        throw error;
      }
    },
    async run(run: (context: NotificationCase) => Promise<void>, signal?: AbortSignal) {
      if (state !== 'ready' || !runtime || stopping) {
        throw new Error('通知検査の環境が利用できません。失敗後のケースは実行しません。');
      }
      state = 'running';
      const abort = () => {
        state = 'failed';
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        const ids: string[] = [];
        await run({
          config,
          runtime,
          newJobId() {
            const id = randomUUID();
            ids.push(id);
            return id;
          },
        });
        signal?.throwIfAborted();
        if (stopping) {
          throw new Error('通知検査中に環境が停止されました。');
        }
        if (ids.length) {
          const values = ids.map((id) => `'${id}'`).join(',');
          await runDatabaseCommand(
            config,
            [
              'execute',
              `
          DELETE FROM job_outbox WHERE job_id IN (${values});
          DELETE FROM jobs WHERE job_id IN (${values});
          CREATE TEMP TABLE cleaned (count INTEGER CHECK (count = 0));
          INSERT INTO cleaned SELECT COUNT(*) FROM job_outbox WHERE job_id IN (${values});
          INSERT INTO cleaned SELECT COUNT(*) FROM jobs WHERE job_id IN (${values});
        `,
            ],
            { signal },
          );
        }
        signal?.throwIfAborted();
        if (stopping) {
          throw new Error('通知検査の清掃中に環境が停止されました。');
        }
        state = 'ready';
      } catch (error) {
        state = 'failed';
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
    stop(): Promise<void> {
      return (stopping ??= (async () => {
        const succeeded = state === 'ready';
        state = 'closed';
        // beforeAllの期限切れでも、起動中の所有プロセスを取り残さない。
        if (startup) {
          runtime = await startup.catch(() => undefined);
        }
        if (!runtime) {
          return;
        }
        // 停止失敗時も証拠を削除せず、呼び出し側へそのまま伝える。
        await runtime.stop();
        const completion = await runtime.closed;
        if (completion.exitCode !== 0) {
          throw new Error('通知検査のWorkerが異常終了しました。');
        }
        if (succeeded) {
          await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
        }
      })());
    },
  };
}
