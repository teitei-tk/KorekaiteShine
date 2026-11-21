import { jsonObject, readJsonObject } from './bombadil-test-json.ts';
import { parseFixtures } from '../bombadil/fixtures.ts';
import type {
  launchRuntime,
  launchBrowser,
  launchBombadil,
  EngineOutcome,
} from '../bombadil/processes.ts';
import type { describeEnvironment } from '../bombadil/environment.ts';
import { requireValue } from '../bombadil/required.ts';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import { runExploration } from '../bombadil/runner.ts';
const mocks = vi.hoisted(() => ({
  describeEnvironment: vi.fn<typeof describeEnvironment>(),
  launchRuntime: vi.fn<typeof launchRuntime>(),
  launchBrowser: vi.fn<typeof launchBrowser>(),
  launchBombadil: vi.fn<typeof launchBombadil>(),
}));
vi.mock('../bombadil/environment.ts', () => ({ describeEnvironment: mocks.describeEnvironment }));
vi.mock('../bombadil/processes.ts', () => ({
  launchRuntime: mocks.launchRuntime,
  launchBrowser: mocks.launchBrowser,
  launchBombadil: mocks.launchBombadil,
}));
const identity = {
  gitSha: 'a'.repeat(40),
  sourceHash: 'b'.repeat(64),
  specHash: 'c'.repeat(64),
  bombadil: { version: 'bombadil 0.7.10', sha256: 'd'.repeat(64) },
  browser: { version: 'Chromium fixture', sha256: 'e'.repeat(64) },
};
test('実行ごとの仕様入口へ保存済みfixtureを渡し、操作と性質だけを公開する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'exploration-entry-'));
  try {
    vi.clearAllMocks();
    const specPath = join(root, 'source "spec".ts');
    await writeFile(
      specPath,
      'export function createSpecification(fixtures) { return { explore: fixtures, invariant: true }; }',
    );
    mocks.describeEnvironment.mockResolvedValue({
      identity,
      binary: '/unused',
      chrome: '/unused',
      specPath,
    });
    mocks.launchRuntime.mockReturnValue({
      result: Promise.resolve('http://127.0.0.1:4321'),
      stop: async () => {
        /* この経路では追加の処理を行わない。 */
      },
    });
    mocks.launchBrowser.mockReturnValue({
      result: Promise.resolve('http://127.0.0.1:9222'),
      stop: async () => {
        /* この経路では追加の処理を行わない。 */
      },
    });
    const observed = { entry: '', exports: [] as string[], fixtures: null as object | null };
    mocks.launchBombadil.mockImplementation(
      (input: { specPath: string; outputDirectory: string }) => ({
        stop: async () => {
          /* この経路では追加の処理を行わない。 */
        },
        result: (async () => {
          observed.entry = input.specPath;
          const specification: unknown = await import(
            /* @vite-ignore */ pathToFileURL(input.specPath).href
          );
          if (
            specification === null ||
            typeof specification !== 'object' ||
            !('explore' in specification)
          ) {
            throw new TypeError('生成した仕様入口が不正です。');
          }
          observed.exports = Object.keys(specification).toSorted();
          observed.fixtures = parseFixtures(JSON.stringify(specification.explore));
          await mkdir(input.outputDirectory);
          await writeFile(
            join(input.outputDirectory, 'trace.jsonl'),
            `${JSON.stringify({
              action: { Custom: { name: 'exercise', arguments: [] } },
              snapshots: [{ name: 'coverage', value: { reached: [] } }],
              violations: [{ name: 'invariant' }],
            })}\n`,
          );
          return {
            exitCode: 2,
            signal: null,
            stdout: 'Test finished with all properties definite',
          };
        })(),
      }),
    );
    const outputDirectory = join(root, 'result');
    const result = await runExploration({ target: 'preparation', seconds: 60, outputDirectory });
    expect(result.status).toBe('violated');
    expect(observed.entry).toBe(join(outputDirectory, 'entry.spec.ts'));
    expect(observed.exports).toEqual(['explore', 'invariant']);
    expect(observed.fixtures).toEqual(
      readJsonObject(await readFile(join(outputDirectory, 'fixtures.json'), 'utf8')),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('起動失敗・探索完了・違反・エラーの各経路で取得したプロセスを停止し、証拠を残す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'exploration-lifecycle-'));
  try {
    for (const scenario of [
      'passed',
      'violated',
      'start-failed',
      'engine-failed',
      'engine-killed',
      'cleanup-failed',
    ] as const) {
      vi.clearAllMocks();
      const runtimeStop = vi.fn(async () => {
        if (scenario === 'cleanup-failed') {
          throw new Error('stop failed');
        }
      });
      const engineStop = vi.fn(async () => {
        /* この経路では追加の処理を行わない。 */
      });
      const browserStop = vi.fn(async () => {
        /* この経路では追加の処理を行わない。 */
      });
      mocks.launchBrowser.mockReturnValue({
        result: Promise.resolve('http://127.0.0.1:9222'),
        stop: browserStop,
      });
      const temporary = { path: '' };
      mocks.describeEnvironment.mockResolvedValue({
        identity,
        binary: '/unused',
        chrome: '/unused',
        specPath: '/unused',
      });
      mocks.launchRuntime.mockImplementation((input: { temporaryDirectory: string }) => {
        temporary.path = input.temporaryDirectory;
        return {
          result:
            scenario === 'start-failed'
              ? Promise.reject(new Error('startup failed'))
              : Promise.resolve('http://127.0.0.1:4321'),
          stop: runtimeStop,
        };
      });
      mocks.launchBombadil.mockImplementation((input: { outputDirectory: string }) => ({
        stop: engineStop,
        result: (async () => {
          await mkdir(input.outputDirectory);
          await writeFile(
            join(input.outputDirectory, 'trace.jsonl'),
            `${JSON.stringify({
              action: { Custom: { name: 'exercise', arguments: [] } },
              snapshots: [
                {
                  name: 'coverage',
                  value: {
                    reached: [
                      'analyzed',
                      'edited-after-confirmation',
                      'blocked-unconfirmed',
                      'delayed-analysis-isolated',
                    ],
                  },
                },
              ],
              violations: scenario === 'violated' ? [{ name: 'invariant' }] : [],
            })}\n`,
          );
          return {
            exitCode:
              scenario === 'engine-killed'
                ? null
                : scenario === 'violated'
                  ? 2
                  : scenario === 'engine-failed'
                    ? 1
                    : 0,
            stdout: 'Test finished after time limit',
            signal: scenario === 'engine-killed' ? 'SIGKILL' : null,
          };
        })(),
      }));
      const directory = join(root, scenario);
      const result = await runExploration({
        target: 'preparation',
        seconds: 60,
        outputDirectory: directory,
      });
      expect(result.status).toBe(
        scenario === 'passed' || scenario === 'violated' ? scenario : 'infrastructure_error',
      );
      expect(result.artifactDirectory).toBe(directory);
      expect(runtimeStop).toHaveBeenCalledOnce();
      if (scenario === 'start-failed') {
        expect(mocks.launchBrowser).not.toHaveBeenCalled();
        expect(mocks.launchBombadil).not.toHaveBeenCalled();
      } else {
        expect(browserStop).toHaveBeenCalledOnce();
        expect(engineStop).toHaveBeenCalledOnce();
        await expect(access(join(directory, 'bombadil/trace.jsonl'))).resolves.toBeUndefined();
      }
      expect(readJsonObject(await readFile(join(directory, 'result.json'), 'utf8'))).toMatchObject(
        result,
      );
      expect(
        readJsonObject(await readFile(join(directory, 'metadata.json'), 'utf8')),
      ).toMatchObject({
        identity,
        target: 'preparation',
      });
      await expect(access(join(directory, 'fixtures.json'))).resolves.toBeUndefined();
      await (scenario === 'cleanup-failed'
        ? rm(temporary.path, { recursive: true, force: true })
        : expect(access(temporary.path)).rejects.toMatchObject({ code: 'ENOENT' }));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('利用者の中断と外側の期限超過では成功にせず、停止後の部分記録から操作数を回収する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'exploration-interrupt-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    for (const reason of ['interrupted', 'deadline'] as const) {
      vi.clearAllMocks();
      const opened = Promise.withResolvers<undefined>();
      const finished = Promise.withResolvers<EngineOutcome>();
      const controller = new AbortController();
      const runtimeStop = vi.fn(async () => {
        /* この経路では追加の処理を行わない。 */
      });
      const browserStop = vi.fn(async () => {
        /* この経路では追加の処理を行わない。 */
      });
      const engineStop = vi.fn(async () => {
        finished.resolve({ exitCode: null, signal: 'SIGTERM', stdout: '' });
      });
      mocks.describeEnvironment.mockResolvedValue({
        identity,
        binary: '/unused',
        chrome: '/unused',
        specPath: '/unused',
      });
      mocks.launchRuntime.mockReturnValue({
        result: Promise.resolve('http://127.0.0.1:4321'),
        stop: runtimeStop,
      });
      mocks.launchBrowser.mockReturnValue({
        result: Promise.resolve('http://127.0.0.1:9222'),
        stop: browserStop,
      });
      mocks.launchBombadil.mockImplementation((input: { outputDirectory: string }) => ({
        stop: engineStop,
        result: (async () => {
          await mkdir(input.outputDirectory);
          await writeFile(
            join(input.outputDirectory, 'trace.jsonl'),
            `${JSON.stringify({
              action: { Custom: { name: 'exercise', arguments: [] } },
              snapshots: [{ name: 'coverage', value: { reached: ['analyzed'] } }],
              violations: [],
            })}\n`,
          );
          opened.resolve(undefined);
          return finished.promise;
        })(),
      }));
      const directory = join(root, reason);
      const running = runExploration(
        { target: 'preparation', seconds: 60, outputDirectory: directory },
        controller.signal,
      );
      await opened.promise;
      if (reason === 'interrupted') {
        controller.abort();
      } else {
        await vi.advanceTimersByTimeAsync(210_000);
      }
      const result = await running;
      expect(result).toMatchObject({ status: 'incomplete', actions: 1, reached: ['analyzed'] });
      expect(runtimeStop).toHaveBeenCalledOnce();
      expect(browserStop).toHaveBeenCalledOnce();
      expect(engineStop).toHaveBeenCalledOnce();
      expect(readJsonObject(await readFile(join(directory, 'metadata.json'), 'utf8')).reason).toBe(
        reason,
      );
      expect(readJsonObject(await readFile(join(directory, 'result.json'), 'utf8'))).toEqual(
        result,
      );
      expect(vi.getTimerCount()).toBe(0);
    }
  } finally {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
test('再現は同じ初期データを新環境に復元し、版・ソース・仕様・fixtureの相違を違反と区別する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'exploration-replay-'));
  vi.clearAllMocks();
  mocks.describeEnvironment.mockResolvedValue({
    identity,
    binary: '/unused',
    chrome: '/unused',
    specPath: '/unused',
  });
  mocks.launchRuntime.mockReturnValue({
    result: Promise.resolve('http://127.0.0.1:4321'),
    stop: async () => {
      /* この経路では追加の処理を行わない。 */
    },
  });
  mocks.launchBrowser.mockReturnValue({
    result: Promise.resolve('http://127.0.0.1:9222'),
    stop: async () => {
      /* この経路では追加の処理を行わない。 */
    },
  });
  mocks.launchBombadil.mockImplementation((input: { outputDirectory: string }) => ({
    stop: async () => {
      /* この経路では追加の処理を行わない。 */
    },
    result: (async () => {
      await mkdir(input.outputDirectory);
      await writeFile(
        join(input.outputDirectory, 'trace.jsonl'),
        `${JSON.stringify({
          action: 'Reload',
          snapshots: [{ name: 'coverage', value: { reached: ['analyzed'] } }],
          violations: [{ name: 'deliberate' }],
        })}\n`,
      );
      return { exitCode: 2, signal: null, stdout: 'Reproduction finished' };
    })(),
  }));
  try {
    const previous = join(root, 'previous');
    const replay = join(root, 'replay');
    expect(
      (await runExploration({ target: 'preparation', seconds: 60, outputDirectory: previous }))
        .status,
    ).toBe('violated');
    expect(
      (
        await runExploration({
          target: 'preparation',
          seconds: 60,
          outputDirectory: replay,
          reproduce: previous,
        })
      ).status,
    ).toBe('violated');
    expect(await readFile(join(replay, 'fixtures.json'), 'utf8')).toBe(
      await readFile(join(previous, 'fixtures.json'), 'utf8'),
    );
    const readMetadata = async (directory: string) =>
      readJsonObject(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect((await readMetadata(previous)).runId).not.toBe((await readMetadata(replay)).runId);
    expect(requireValue(mocks.launchRuntime.mock.calls[0])[0].temporaryDirectory).not.toBe(
      requireValue(mocks.launchRuntime.mock.calls[1])[0].temporaryDirectory,
    );
    expect(requireValue(mocks.launchBombadil.mock.calls[1])[0].reproduce).toBe(
      join(previous, 'bombadil'),
    );
    for (const change of [
      'gitSha',
      'sourceHash',
      'specHash',
      'bombadil',
      'browser',
      'fixture',
    ] as const) {
      const altered = join(root, `altered-${change}`);
      const output = join(root, `rejected-${change}`);
      await cp(previous, altered, { recursive: true });
      const metadata = await readMetadata(altered);
      if (change === 'fixture') {
        const fixture = parseFixtures(await readFile(join(altered, 'fixtures.json'), 'utf8'));
        requireValue(fixture.interviews[0]).theme = '改変されたテーマ';
        await writeFile(join(altered, 'fixtures.json'), JSON.stringify(fixture));
      } else if (change === 'bombadil' || change === 'browser') {
        jsonObject(jsonObject(metadata.identity)[change]).version = 'changed';
      } else {
        jsonObject(metadata.identity)[change] = 'changed';
      }
      await writeFile(join(altered, 'metadata.json'), JSON.stringify(metadata));
      mocks.launchRuntime.mockClear();
      const result = await runExploration({
        target: 'preparation',
        seconds: 60,
        outputDirectory: output,
        reproduce: altered,
      });
      expect(result.status).toBe('infrastructure_error');
      expect((await readMetadata(output)).reason).toBe('reproduction_mismatch');
      expect(mocks.launchRuntime).not.toHaveBeenCalled();
    }
    await expect(
      runExploration({ target: 'preparation', seconds: 60, outputDirectory: previous }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('完了通知の欠落と中断前後の記録異常を区別し、成功や性質違反として扱わない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'exploration-terminal-'));
  try {
    for (const scenario of [
      'no-terminal',
      'sigint',
      'sigterm',
      'stdout-interrupt',
      'pre-aborted',
      'partial-invalid',
      'partial-missing',
      'partial-directory',
      'partial-cleanup',
    ] as const) {
      vi.clearAllMocks();
      const controller = new AbortController();
      const partial = scenario.startsWith('partial-');
      const finished = Promise.withResolvers<EngineOutcome>();
      const temporary = { path: '' };
      const runtimeStop = vi.fn(async () => {
        if (scenario === 'partial-cleanup') {
          throw new Error('fixture cleanup failed');
        }
      });
      const browserStop = vi.fn(async () => undefined);
      const engineStop = vi.fn(async () => {
        finished.resolve({ exitCode: null, signal: 'SIGTERM', stdout: '' });
      });
      mocks.describeEnvironment.mockResolvedValue({
        identity,
        binary: '/unused',
        chrome: '/unused',
        specPath: '/unused',
      });
      mocks.launchRuntime.mockImplementation((input) => {
        temporary.path = input.temporaryDirectory;
        return { result: Promise.resolve('http://127.0.0.1:4321'), stop: runtimeStop };
      });
      mocks.launchBrowser.mockReturnValue({
        result: Promise.resolve('http://127.0.0.1:9222'),
        stop: browserStop,
      });
      mocks.launchBombadil.mockImplementation((input) => ({
        stop: engineStop,
        result: (async (): Promise<EngineOutcome> => {
          await mkdir(input.outputDirectory);
          const tracePath = join(input.outputDirectory, 'trace.jsonl');
          if (scenario === 'partial-directory') {
            await mkdir(tracePath);
          } else if (scenario !== 'partial-missing') {
            await writeFile(
              tracePath,
              partial
                ? '{'
                : JSON.stringify({
                    action: 'Reload',
                    snapshots: [
                      {
                        name: 'coverage',
                        value: {
                          reached: [
                            'analyzed',
                            'edited-after-confirmation',
                            'blocked-unconfirmed',
                            'delayed-analysis-isolated',
                          ],
                        },
                      },
                    ],
                    violations: [],
                  }),
            );
          }
          if (partial) {
            controller.abort();
            return finished.promise;
          }
          return {
            exitCode: scenario === 'sigint' || scenario === 'sigterm' ? null : 0,
            signal: scenario === 'sigint' ? 'SIGINT' : scenario === 'sigterm' ? 'SIGTERM' : null,
            stdout: scenario === 'stdout-interrupt' ? 'interrupted by SIGINT' : '',
          };
        })(),
      }));
      if (scenario === 'pre-aborted') {
        controller.abort();
      }
      const directory = join(root, scenario);
      try {
        const result = await runExploration(
          { target: 'preparation', seconds: 60, outputDirectory: directory },
          controller.signal,
        );
        const invalid = [
          'no-terminal',
          'partial-invalid',
          'partial-directory',
          'partial-cleanup',
        ].includes(scenario);
        expect(result).toMatchObject({
          status: invalid ? 'infrastructure_error' : 'incomplete',
          actions: partial || scenario === 'pre-aborted' ? 0 : 1,
        });
        const reason =
          scenario === 'no-terminal'
            ? 'infrastructure_error'
            : scenario === 'partial-cleanup'
              ? 'cleanup_failed'
              : scenario === 'partial-invalid' || scenario === 'partial-directory'
                ? 'recording_invalid'
                : 'interrupted';
        expect(
          readJsonObject(await readFile(join(directory, 'metadata.json'), 'utf8')).reason,
        ).toBe(reason);
        expect(readJsonObject(await readFile(join(directory, 'result.json'), 'utf8'))).toEqual(
          result,
        );
        if (scenario === 'pre-aborted') {
          expect(mocks.launchRuntime).not.toHaveBeenCalled();
          expect(mocks.launchBrowser).not.toHaveBeenCalled();
          expect(mocks.launchBombadil).not.toHaveBeenCalled();
        } else {
          expect(runtimeStop).toHaveBeenCalledOnce();
          expect(browserStop).toHaveBeenCalledOnce();
          expect(engineStop).toHaveBeenCalledOnce();
          if (scenario !== 'partial-cleanup') {
            await expect(access(temporary.path)).rejects.toMatchObject({ code: 'ENOENT' });
          }
        }
      } finally {
        if (temporary.path) {
          await rm(temporary.path, { recursive: true, force: true });
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('記録先未指定でも実行ごとに独立した既定ディレクトリへ起動失敗の証拠を保存する', async () => {
  vi.clearAllMocks();
  mocks.describeEnvironment.mockRejectedValue(new Error('fixture environment unavailable'));
  const directories: string[] = [];
  const parent = fileURLToPath(new URL('../../../.local/bombadil/', import.meta.url));
  try {
    for (const attempt of [1, 2]) {
      const result = await runExploration({ target: 'preparation', seconds: 60 });
      expect(`${dirname(result.artifactDirectory)}/`).toBe(parent);
      directories.push(result.artifactDirectory);
      expect(result).toMatchObject({ status: 'infrastructure_error', actions: 0, reached: [] });
      const metadata = readJsonObject(
        await readFile(join(result.artifactDirectory, 'metadata.json'), 'utf8'),
      );
      expect(metadata).toMatchObject({
        reason: 'setup_failed',
        identity: null,
        target: 'preparation',
        seconds: 60,
      });
      expect(metadata.runId).toBe(basename(result.artifactDirectory));
      expect(metadata.runId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u);
      expect(
        readJsonObject(await readFile(join(result.artifactDirectory, 'result.json'), 'utf8')),
      ).toEqual(result);
      expect(new Set(directories).size).toBe(attempt);
    }
    expect(mocks.launchRuntime).not.toHaveBeenCalled();
    expect(mocks.launchBrowser).not.toHaveBeenCalled();
    expect(mocks.launchBombadil).not.toHaveBeenCalled();
  } finally {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
});
