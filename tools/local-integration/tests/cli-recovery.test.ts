import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import type { RuntimeConfig } from '@korekaite/runtime-config';
import { buildRuntime, runDatabaseCommand } from '../src/runtime.ts';
import { runWithEvidence } from '../src/evidence.ts';
import { runtimeVersions } from '../src/versions.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

function launchCli(config: RuntimeConfig, runId: string, slot: number, mode: 'dev' | 'preview') {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/run.ts', import.meta.url)), mode],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        APP_ENV: config.environment,
        LOCAL_TEST_RUN_ID: runId,
        LOCAL_TEST_SLOT: String(slot),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const outputState = { output: '' };
  child.stdout.on('data', (chunk: Buffer) => {
    outputState.output += chunk.toString();
  });
  child.stderr.resume();
  const closed = new Promise<number>((resolve) => {
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', () => resolve(1));
  });
  return {
    async ready(): Promise<string> {
      const baseUrlState = { baseUrl: undefined as string | undefined };
      await expect
        .poll(
          () => {
            baseUrlState.baseUrl = outputState.output.match(
              /ローカルWeb: (http:\/\/127\.0\.0\.1:\d+)/u,
            )?.[1];
            return baseUrlState.baseUrl !== undefined;
          },
          { timeout: 60_000, interval: 100 },
        )
        .toBe(true);
      return baseUrlState.baseUrl!;
    },
    async stop(): Promise<number> {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      const timerState = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
      try {
        return await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timerState.timer = setTimeout(
              () => reject(new Error('CLIの停止期限を超過しました。')),
              15_000,
            );
          }),
        ]);
      } catch (error) {
        child.kill('SIGKILL');
        await closed;
        throw error;
      } finally {
        clearTimeout(timerState.timer);
      }
    },
  };
}

test('通常CLIの開発・ビルド済み起動は再起動後も60秒周期で回復し、停止すると終了する', async () => {
  const runId = randomUUID();
  for (const [slot, mode] of (['dev', 'preview'] as const).entries()) {
    const config = resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex: slot });
    await runWithEvidence(
      {
        resultPath: join(dirname(config.artifactDirectory), 'results.json'),
        metadata: {
          environment: 'test',
          runId,
          parallelIndex: slot,
          case: 'cli-scheduled-recovery',
          mode,
          clock: 'real',
          versions: await runtimeVersions(),
          expected: { status: 'completed', attemptCount: 2, intervalMs: 60_000, cliExitCode: 0 },
        },
      },
      async (evidence) => {
        evidence.cleanup(async (passed) => {
          if (!passed) {
            return;
          }
          await rm(config.stateDirectory!, { recursive: true, force: true });
          await rm(config.artifactDirectory, { recursive: true, force: true });
        });
        const cliState = { cli: undefined as ReturnType<typeof launchCli> | undefined };
        evidence.cleanup(async () => {
          await cliState.cli?.stop();
        });
        if (mode === 'preview') {
          await buildRuntime(config);
        }
        cliState.cli = launchCli(config, runId, slot, mode);
        const baseUrlState = { baseUrl: await cliState.cli.ready() };
        const accepted = await fetch(`${baseUrlState.baseUrl}/api/diagnostics/check-jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ scenario: 'retry_then_success' }),
          signal: AbortSignal.timeout(10_000),
        });
        expect(accepted.status).toBe(202);
        const { jobId } = await accepted.json();
        const status = async () =>
          (
            await fetch(`${baseUrlState.baseUrl}/api/diagnostics/check-jobs/${jobId}`, {
              signal: AbortSignal.timeout(10_000),
            })
          ).json();
        await expect.poll(status, { timeout: 20_000, interval: 100 }).toMatchObject({
          status: 'retry_wait',
          attemptCount: 1,
        });
        const before = await status();
        await runDatabaseCommand(config, [
          'execute',
          `
        CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
        INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE job_id = '${jobId}' AND operation = 'notify' AND generation = 1 AND sent_at IS NOT NULL;
      `,
        ]);
        expect(await cliState.cli.stop()).toBe(0);
        cliState.cli = undefined;
        expect(
          Temporal.Now.instant().epochMilliseconds,
          '予約済み再試行の配送前に停止する',
        ).toBeLessThan(Temporal.Instant.from(before.nextAttemptAt).epochMilliseconds);
        evidence.observe({
          beforeRestart: {
            status: before.status,
            attemptCount: before.attemptCount,
            delayedNotificationSentVerified: true,
          },
        });
        cliState.cli = launchCli(config, runId, slot, mode);
        baseUrlState.baseUrl = await cliState.cli.ready();
        const readyAt = performance.now();
        expect(await status()).toMatchObject({ status: 'retry_wait', attemptCount: 1 });
        // テストからscheduledや回復関数を呼ばず、実CLI自身の周期処理を待つ。
        await expect
          .poll(
            async () => {
              const result = await status();
              evidence.observe({
                afterRestart: { status: result.status, attemptCount: result.attemptCount },
              });
              return result;
            },
            { timeout: 90_000, interval: 500 },
          )
          .toMatchObject({ status: 'completed', attemptCount: 2 });
        const recoveryAfterReadyMs = Math.round(performance.now() - readyAt);
        // URL出力から受信までの微小な遅れだけを許容し、即時・短縮周期を除外する。
        expect(recoveryAfterReadyMs).toBeGreaterThanOrEqual(59_000);
        await runDatabaseCommand(config, [
          'execute',
          `
        CREATE TEMP TABLE two (count INTEGER CHECK (count = 2));
        INSERT INTO two SELECT COUNT(*) FROM job_attempts WHERE job_id = '${jobId}';
        CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
        INSERT INTO one SELECT COUNT(*) FROM connection_checks WHERE writer = 'scheduled';
      `,
        ]);
        const exitCode = await cliState.cli.stop();
        cliState.cli = undefined;
        expect(exitCode).toBe(0);
        evidence.observe({
          recoveryAfterReadyMs,
          cliExitCode: exitCode,
          databaseAssertionsPassed: true,
        });
      },
    );
  }
}, 300_000);
