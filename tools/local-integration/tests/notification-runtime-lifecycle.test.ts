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
    let evidence = '';
    let stops = 0;
    const start = vi.spyOn(runtimeModule, 'startRuntime').mockImplementationOnce(async (config) => {
      evidence = join(config.artifactDirectory, 'evidence.txt');
      await mkdir(config.artifactDirectory, { recursive: true });
      await writeFile(evidence, 'failure evidence');
      if (stage === 'start') {
        throw original;
      }
      return {
        baseUrl: 'http://127.0.0.1:1',
        closed: Promise.resolve({ exitCode: 0 }),
        async runScheduled() {},
        async stop() {
          stops++;
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
      if (evidence) {
        await rm(dirname(dirname(evidence)), { recursive: true, force: true });
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
    let called = false;
    await expect(
      suite.run(async () => {
        called = true;
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
    if (stage !== 'stop') {
      await suite.stop();
    }
    expect(stops).toBe(stage === 'start' ? 0 : 1);
    expect(await readFile(evidence, 'utf8')).toBe('failure evidence');
  },
);

test('起動待ちの間に停止しても、後から起動したWorkerを停止して証拠を保持する', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let evidence = '';
  let stops = 0;
  const start = vi.spyOn(runtimeModule, 'startRuntime').mockImplementationOnce(async (config) => {
    evidence = join(config.artifactDirectory, 'startup.txt');
    await mkdir(config.artifactDirectory, { recursive: true });
    await writeFile(evidence, 'startup evidence');
    await gate;
    return {
      baseUrl: 'http://127.0.0.1:1',
      closed: Promise.resolve({ exitCode: 0 }),
      async runScheduled() {},
      async stop() {
        stops++;
      },
    };
  });
  onTestFinished(async () => {
    release();
    start.mockRestore();
    if (evidence) {
      await rm(dirname(dirname(evidence)), { recursive: true, force: true });
    }
  });
  const suite = createNotificationRuntime();
  const starting = suite.start();
  const stopped = suite.stop();
  release();
  await expect(starting).rejects.toThrow();
  await stopped;
  expect(stops).toBe(1);
  expect(await readFile(evidence, 'utf8')).toBe('startup evidence');
});

test.each(['stop', 'abort'] as const)(
  '清掃待ち中の%s後に完了しても環境を再開しない',
  async (ending) => {
    let release = () => {};
    let entered = () => {};
    const cleaning = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let evidence = '';
    const start = vi.spyOn(runtimeModule, 'startRuntime').mockImplementationOnce(async (config) => {
      evidence = join(config.artifactDirectory, 'cleanup.txt');
      await mkdir(config.artifactDirectory, { recursive: true });
      await writeFile(evidence, 'cleanup evidence');
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
        entered();
        await gate;
      });
    onTestFinished(async () => {
      release();
      start.mockRestore();
      database.mockRestore();
      if (evidence) {
        await rm(dirname(dirname(evidence)), { recursive: true, force: true });
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
    release();
    await expect(running).rejects.toThrow();
    let called = false;
    await expect(
      suite.run(async () => {
        called = true;
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
    await suite.stop();
    expect(await readFile(evidence, 'utf8')).toBe('cleanup evidence');
  },
);
