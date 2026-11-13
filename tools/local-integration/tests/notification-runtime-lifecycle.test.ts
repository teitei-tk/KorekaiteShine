import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import * as runtimeModule from '../src/runtime.ts';
import { createNotificationRuntime } from './helpers/notification-runtime.ts';

// Workerの起動・停止とDB故障だけを置き換え、ヘルパーの状態遷移と証拠ファイルは実物で検査する。
test.each(['start', 'case', 'cleanup', 'stop'] as const)(
  '%sの失敗を保持し、後続ケースを拒否して証拠を消さず停止する',
  async (stage) => {
    const original = new Error(`injected ${stage}`);
    const evidenceContext = { evidence: '', stops: 0 };
    const start = vi.spyOn(runtimeModule, 'startRuntime').mockImplementationOnce(async (config) => {
      evidenceContext.evidence = join(config.artifactDirectory, 'evidence.txt');
      await mkdir(config.artifactDirectory, { recursive: true });
      await writeFile(evidenceContext.evidence, 'failure evidence');
      if (stage === 'start') {
        throw original;
      }
      return {
        baseUrl: 'http://127.0.0.1:1',
        closed: Promise.resolve({ exitCode: 0 }),
        async runScheduled() {},
        async stop() {
          evidenceContext.stops++;
          if (stage === 'stop') {
            throw original;
          }
        },
      };
    });
    const database = vi.spyOn(runtimeModule, 'runDatabaseCommand').mockImplementation(async () => {
      if (stage === 'cleanup') {
        throw original;
      }
    });
    onTestFinished(async () => {
      start.mockRestore();
      database.mockRestore();
      if (evidenceContext.evidence) {
        await rm(dirname(dirname(evidenceContext.evidence)), { recursive: true, force: true });
      }
    });
    const suite = createNotificationRuntime();
    if (stage === 'start') {
      await expect(suite.start()).rejects.toBe(original);
    } else {
      await suite.start();
      const run = suite.run(async ({ newJobId }) => {
        newJobId();
        if (stage === 'case') {
          throw original;
        }
      });
      if (stage === 'stop') {
        await run;
      } else {
        await expect(run).rejects.toBe(original);
      }
    }
    if (stage === 'stop') {
      await expect(suite.stop()).rejects.toBe(original);
    }
    const calledState = { called: false };
    await expect(
      suite.run(async () => {
        calledState.called = true;
      }),
    ).rejects.toThrow();
    expect(calledState.called).toBe(false);
    if (stage !== 'stop') {
      await suite.stop();
    }
    expect(evidenceContext.stops).toBe(stage === 'start' ? 0 : 1);
    expect(await readFile(evidenceContext.evidence, 'utf8')).toBe('failure evidence');
  },
);

test('起動待ちの間に停止しても、後から起動したWorkerを停止して証拠を保持する', async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const evidenceContext = { evidence: '', stops: 0 };
  const start = vi.spyOn(runtimeModule, 'startRuntime').mockImplementationOnce(async (config) => {
    evidenceContext.evidence = join(config.artifactDirectory, 'startup.txt');
    await mkdir(config.artifactDirectory, { recursive: true });
    await writeFile(evidenceContext.evidence, 'startup evidence');
    await gate;
    return {
      baseUrl: 'http://127.0.0.1:1',
      closed: Promise.resolve({ exitCode: 0 }),
      async runScheduled() {},
      async stop() {
        evidenceContext.stops++;
      },
    };
  });
  onTestFinished(async () => {
    release();
    start.mockRestore();
    if (evidenceContext.evidence) {
      await rm(dirname(dirname(evidenceContext.evidence)), { recursive: true, force: true });
    }
  });
  const suite = createNotificationRuntime();
  const starting = suite.start();
  const stopped = suite.stop();
  release();
  await expect(starting).rejects.toThrow();
  await stopped;
  expect(evidenceContext.stops).toBe(1);
  expect(await readFile(evidenceContext.evidence, 'utf8')).toBe('startup evidence');
});

test.each(['stop', 'abort'] as const)(
  '清掃待ち中の%s後に完了しても環境を再開しない',
  async (ending) => {
    const releaseContext = { release: () => {}, entered: () => {} };
    const cleaning = new Promise<void>((resolve) => {
      releaseContext.entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseContext.release = resolve;
    });
    const evidenceState = { evidence: '' };
    const start = vi.spyOn(runtimeModule, 'startRuntime').mockImplementationOnce(async (config) => {
      evidenceState.evidence = join(config.artifactDirectory, 'cleanup.txt');
      await mkdir(config.artifactDirectory, { recursive: true });
      await writeFile(evidenceState.evidence, 'cleanup evidence');
      return {
        baseUrl: 'http://127.0.0.1:1',
        closed: Promise.resolve({ exitCode: 0 }),
        async runScheduled() {},
        async stop() {},
      };
    });
    const database = vi
      .spyOn(runtimeModule, 'runDatabaseCommand')
      .mockImplementationOnce(async () => {
        releaseContext.entered();
        await gate;
      });
    onTestFinished(async () => {
      releaseContext.release();
      start.mockRestore();
      database.mockRestore();
      if (evidenceState.evidence) {
        await rm(dirname(dirname(evidenceState.evidence)), { recursive: true, force: true });
      }
    });
    const suite = createNotificationRuntime();
    await suite.start();
    const controller = new AbortController();
    const running = suite.run(async ({ newJobId }) => {
      newJobId();
    }, controller.signal);
    await cleaning;
    if (ending === 'stop') {
      await suite.stop();
    } else {
      controller.abort(new Error('test timed out'));
    }
    releaseContext.release();
    await expect(running).rejects.toThrow();
    const calledState = { called: false };
    await expect(
      suite.run(async () => {
        calledState.called = true;
      }),
    ).rejects.toThrow();
    expect(calledState.called).toBe(false);
    await suite.stop();
    expect(await readFile(evidenceState.evidence, 'utf8')).toBe('cleanup evidence');
  },
);
