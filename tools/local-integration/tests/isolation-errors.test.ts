import { parseJson } from '@korekaite/api-contracts/json';
import type * as LintTypeModule0 from 'node:fs/promises';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { runIsolationIntegration } from '../src/isolation.ts';
import { startRuntime } from '../src/runtime.ts';

vi.mock('../src/runtime.ts', () => ({ startRuntime: vi.fn(), runDatabaseCommand: vi.fn() }));
vi.mock('../src/versions.ts', () => ({ runtimeVersions: async () => ({ node: 'controlled' }) }));
vi.mock('../src/development-snapshot.ts', () => ({
  readDevelopmentArtifactState: async () => [],
  readDevelopmentSnapshot: async () => ({ tables: {}, sentinelCount: 1, sentinelMatches: true }),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof LintTypeModule0>();
  return {
    ...original,
    readFile: async (
      path: Parameters<typeof readFile>[0],
      options?: Parameters<typeof readFile>[1],
    ) =>
      (typeof path === 'string' ? path : path instanceof URL ? path.pathname : '').endsWith(
        '/isolation-output.txt',
      )
        ? 'development-retained-v1'
        : original.readFile(path, options ?? null),
  };
});
afterEach(() => vi.resetAllMocks());

test('並列起動の片方が失敗しても成功した側を停止し検査失敗を記録する', async () => {
  const runDirectoryContext = { runDirectory: '', starts: 0 };
  const stop = vi.fn(async () => {
    /* この実装では追加の処理を行わない。 */
  });
  vi.mocked(startRuntime).mockImplementation(async (config) => {
    runDirectoryContext.runDirectory = dirname(dirname(config.artifactDirectory));
    onTestFinished(() => rm(runDirectoryContext.runDirectory, { recursive: true, force: true }));
    if (runDirectoryContext.starts++ === 0) {
      throw new Error('private details');
    }
    return {
      baseUrl: 'http://isolation.invalid',
      stop,
      closed: Promise.resolve({ exitCode: 0 }),
      runScheduled: async () => {
        /* この実装では追加の処理を行わない。 */
      },
    };
  });
  await expect(runIsolationIntegration()).rejects.toThrow('private details');
  expect(stop).toHaveBeenCalledTimes(1);
  const report = await readFile(join(runDirectoryContext.runDirectory, '2/results.json'), 'utf8');
  expect(report).not.toContain('private details');
  expect(parseJson(report)).toMatchObject({ exitCode: 1, failureCode: 'CASE_FAILED' });
});
