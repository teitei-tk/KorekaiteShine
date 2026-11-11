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
  const runtimeContext = {
    runtime: undefined as LocalRuntime | undefined,
    startup: undefined as Promise<LocalRuntime> | undefined,
    state: 'new' as 'new' | 'starting' | 'ready' | 'running' | 'failed' | 'closed',
    stopping: undefined as Promise<void> | undefined,
  };
  return {
    async start() {
      if (runtimeContext.state !== 'new') {
        throw new Error('通知検査の環境は一度だけ起動できます。');
      }
      runtimeContext.state = 'starting';
      try {
        runtimeContext.runtime = await (runtimeContext.startup = startRuntime(config, 'dev', {
          manualDiagnostics: true,
          probeOnlyEvaluation: true,
        }));
        if (runtimeContext.stopping) {
          throw new Error('通知検査の起動中に停止されました。');
        }
        runtimeContext.state = 'ready';
      } catch (error) {
        runtimeContext.state = 'failed';
        throw error;
      }
    },
    async run(run: (context: NotificationCase) => Promise<void>, signal?: AbortSignal) {
      if (runtimeContext.state !== 'ready' || !runtimeContext.runtime || runtimeContext.stopping) {
        throw new Error('通知検査の環境が利用できません。失敗後のケースは実行しません。');
      }
      runtimeContext.state = 'running';
      const abort = () => {
        runtimeContext.state = 'failed';
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        const ids: string[] = [];
        await run({
          config,
          runtime: runtimeContext.runtime,
          newJobId() {
            const id = randomUUID();
            ids.push(id);
            return id;
          },
        });
        signal?.throwIfAborted();
        if (runtimeContext.stopping) {
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
        if (runtimeContext.stopping) {
          throw new Error('通知検査の清掃中に環境が停止されました。');
        }
        runtimeContext.state = 'ready';
      } catch (error) {
        runtimeContext.state = 'failed';
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
    stop(): Promise<void> {
      return (runtimeContext.stopping ??= (async () => {
        const succeeded = runtimeContext.state === 'ready';
        runtimeContext.state = 'closed';
        // beforeAllの期限切れでも、起動中の所有プロセスを取り残さない。
        if (runtimeContext.startup) {
          runtimeContext.runtime = await runtimeContext.startup.catch(() => undefined);
        }
        if (!runtimeContext.runtime) {
          return;
        }
        // 停止失敗時も証拠を削除せず、呼び出し側へそのまま伝える。
        await runtimeContext.runtime.stop();
        const completion = await runtimeContext.runtime.closed;
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
