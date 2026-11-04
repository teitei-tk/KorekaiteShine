import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readDevelopmentSnapshot, readDevelopmentArtifactState } from './development-snapshot.ts';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveRuntime } from '@korekaite/runtime-config';
import { runWithEvidence } from './evidence.ts';
import { runtimeVersions } from './versions.ts';
import { startRuntime, runDatabaseCommand, type LocalRuntime } from './runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function json(runtime: LocalRuntime, path: string, init: RequestInit = {}, status = 200) {
  const response = await fetch(`${runtime.baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, status);
  return response.json();
}

async function waitForCompleted(runtime: LocalRuntime, jobId: string) {
  const deadline = performance.now() + 30_000;
  for (;;) {
    const job = await json(runtime, `/api/formal-queue-test?jobId=${jobId}`);
    assert.equal(job.jobId, jobId);
    assert.equal(job.purpose, 'evaluation');
    if (job.status === 'completed') {
      assert.equal(job.attemptCount, 1);
      return { status: String(job.status), attemptCount: Number(job.attemptCount) };
    }
    assert.notEqual(job.status, 'failed');
    assert.ok(performance.now() < deadline, '隔離検証のジョブが完了しませんでした。');
    await delay(100);
  }
}

export async function runIsolationIntegration(): Promise<string> {
  const runId = randomUUID();
  const development = resolveRuntime({ repositoryRoot, appEnv: 'development' });
  const configs = [0, 1].map((parallelIndex) =>
    resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex }),
  );
  // slot 2は二環境をまとめる検査記録専用で、ランタイムを起動しない。
  const evidenceConfig = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId,
    parallelIndex: 2,
  });
  const resultPath = join(dirname(evidenceConfig.artifactDirectory), 'results.json');
  await runWithEvidence(
    {
      resultPath,
      metadata: {
        environment: 'test',
        runId,
        parallelIndex: 2,
        case: 'parallel-isolation',
        mode: 'dev',
        clock: 'real',
        versions: await runtimeVersions(),
        expected: {
          testSlots: [0, 1],
          developmentUnchanged: true,
          developmentArtifactsUnchanged: true,
          separateD1: true,
          separateDo: true,
          separateQueues: true,
          separateOutputs: true,
        },
      },
    },
    async (evidence) => {
      evidence.cleanup(async (passed) => {
        if (!passed) {
          return;
        }
        for (const config of configs) {
          await rm(config.stateDirectory!, { recursive: true, force: true });
          await rm(config.artifactDirectory, { recursive: true, force: true });
        }
      });
      const developmentArtifactsBefore = await readDevelopmentArtifactState(development);
      const devOutput = join(development.artifactDirectory, 'isolation-output.txt');
      assert.ok(
        (await readFile(devOutput, 'utf8')) === 'development-retained-v1',
        '保持確認用の出力が想定値と異なります。',
      );
      const developmentBefore = await readDevelopmentSnapshot(development);
      evidence.observe({ developmentBefore, developmentArtifactsBefore });
      const started = await Promise.allSettled(
        configs.map(async (config) => {
          const runtime = await startRuntime(config);
          evidence.cleanup(() => runtime.stop());
          return runtime;
        }),
      );
      const runtimes = started.map((result) => {
        if (result.status === 'rejected') {
          throw result.reason;
        }
        return result.value;
      });
      const markers = [randomUUID(), randomUUID()];
      const writeMarker = (slot: number) =>
        json(runtimes[slot]!, '/api/isolation-test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marker: markers[slot] }),
        });
      await writeMarker(0);
      const secondDoBeforeWrite = await json(runtimes[1]!, '/api/isolation-test');
      evidence.observe({ secondDoBeforeWrite });
      assert.equal(secondDoBeforeWrite, null);
      await writeMarker(1);
      const observedMarkers = await Promise.all(
        runtimes.map((runtime) => json(runtime, '/api/isolation-test')),
      );
      const doMarkersIsolated = observedMarkers.every((marker, slot) => marker === markers[slot]);
      evidence.observe({ doMarkersIsolated });
      assert.equal(doMarkersIsolated, true);
      const outputPaths = configs.map((config) =>
        join(config.artifactDirectory, 'isolation-output.txt'),
      );
      assert.equal(new Set([devOutput, ...outputPaths]).size, 3);
      await Promise.all(
        outputPaths.map((path, slot) => writeFile(path, markers[slot]!, { flag: 'wx' })),
      );
      const outputs = await Promise.all(outputPaths.map((path) => readFile(path, 'utf8')));
      const outputMarkersIsolated =
        outputs.every((value, slot) => value === markers[slot]) &&
        (await readFile(devOutput, 'utf8')) === 'development-retained-v1';
      evidence.observe({ outputMarkersIsolated });
      assert.equal(outputMarkersIsolated, true);
      const jobId = randomUUID();
      const now = Temporal.Now.instant().epochMilliseconds;
      await Promise.all(
        configs.map((config, slot) =>
          runDatabaseCommand(config, [
            'execute',
            `
      INSERT INTO jobs (job_id, actor_id, purpose, status, attempt_count, accepted_at, updated_at, generation)
      VALUES ('${jobId}', 'isolation-${slot}', 'evaluation', 'pending', 0, ${now}, ${now}, 0);
    `,
          ]),
        ),
      );
      const testEnvironments: {
        slot: number;
        status: string;
        attemptCount: number;
        queue: string;
        queueMatches: boolean;
      }[] = [];
      evidence.observe({ testEnvironments });
      for (const slot of [0, 1]) {
        if (slot === 1) {
          const job = await json(runtimes[1]!, `/api/formal-queue-test?jobId=${jobId}`);
          const secondJobBeforeSend = {
            status: String(job.status),
            attemptCount: Number(job.attemptCount),
          };
          const secondQueueBeforeSend = await json(
            runtimes[1]!,
            `/api/check-object-test?jobId=${jobId}`,
          );
          evidence.observe({ secondJobBeforeSend, secondQueueBeforeSend });
          assert.deepEqual(secondJobBeforeSend, { status: 'pending', attemptCount: 0 });
          assert.equal(secondQueueBeforeSend, null);
        }
        await json(
          runtimes[slot]!,
          `/api/formal-queue-test?source=${slot === 0 ? 'web' : 'interview'}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schemaVersion: 1, jobId }),
          },
          202,
        );
        const completed = await waitForCompleted(runtimes[slot]!, jobId);
        const receipt = await json(runtimes[slot]!, `/api/check-object-test?jobId=${jobId}`);
        const queueMatches = receipt.queue === configs[slot]!.queues.evaluation.queue;
        testEnvironments.push({ slot, ...completed, queue: String(receipt.queue), queueMatches });
        assert.equal(queueMatches, true);
        assert.deepEqual(receipt.message, { schemaVersion: 1, jobId });
      }
      assert.equal(new Set(testEnvironments.map((entry) => entry.queue)).size, 2);
      const developmentAfter = await readDevelopmentSnapshot(development);
      const developmentArtifactsAfter = await readDevelopmentArtifactState(development);
      const developmentArtifactsUnchanged = isDeepStrictEqual(
        developmentArtifactsBefore,
        developmentArtifactsAfter,
      );
      evidence.observe({ developmentArtifactsAfter, developmentArtifactsUnchanged });
      assert.equal(developmentArtifactsUnchanged, true);
      evidence.observe({ developmentAfter });
      assert.deepEqual(developmentAfter, developmentBefore);
    },
  );
  return resultPath;
}
