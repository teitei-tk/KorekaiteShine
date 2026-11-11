import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import {
  runHttpContractIntegration,
  runDiagnosticHttpContractIntegration,
} from '../src/http-contract.ts';
import { startRuntime } from '../src/runtime.ts';

vi.mock('../src/runtime.ts', () => ({
  startRuntime: vi.fn(),
  buildRuntime: vi.fn(),
  runDatabaseCommand: vi.fn(),
}));
vi.mock('../src/versions.ts', () => ({ runtimeVersions: async () => ({ node: 'controlled' }) }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test('診断HTTPのContent-Type欠落を契約違反にし調査用の成果物を残す', async () => {
  const fixture = await failureFixture();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 400, headers: { 'Cache-Control': 'no-store' } }),
      ),
  );
  await expect(runDiagnosticHttpContractIntegration()).rejects.toThrow();
  expect(fixture.stop).toHaveBeenCalledTimes(1);
  expect(await readFile(join(fixture.directory(), 'evidence.txt'), 'utf8')).toBe('retain');
  expect(
    JSON.parse(await readFile(join(dirname(fixture.directory()), 'results.json'), 'utf8')),
  ).toMatchObject({ exitCode: 1, failureCode: 'CASE_FAILED' });
});

async function failureFixture() {
  const directoryState = { directory: '' };
  const stop = vi.fn(async () => {});
  vi.mocked(startRuntime).mockImplementation(async (config) => {
    directoryState.directory = config.artifactDirectory;
    onTestFinished(() =>
      rm(dirname(dirname(directoryState.directory)), { recursive: true, force: true }),
    );
    await mkdir(directoryState.directory, { recursive: true });
    await writeFile(join(directoryState.directory, 'evidence.txt'), 'retain');
    return {
      baseUrl: 'http://contract.invalid',
      stop,
      closed: Promise.resolve({ exitCode: 0 }),
      runScheduled: async () => {},
    };
  });
  return { stop, directory: () => directoryState.directory };
}

test('面談HTTP契約の失敗ではランタイムを停止し調査用の成果物を残す', async () => {
  const fixture = await failureFixture();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private details')));
  await expect(runHttpContractIntegration()).rejects.toThrow('private details');
  expect(fixture.stop).toHaveBeenCalledTimes(1);
  expect(await readFile(join(fixture.directory(), 'evidence.txt'), 'utf8')).toBe('retain');
  expect(await readFile(join(dirname(fixture.directory()), 'results.json'), 'utf8')).not.toContain(
    'private details',
  );
});
