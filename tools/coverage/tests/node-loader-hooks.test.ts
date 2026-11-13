import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import type { SourceCoverageData } from '@vitest/istanbul-lib-instrument';
import { expect, onTestFinished, test, vi } from 'vitest';
import { prepareRun } from '../src/prepare.ts';
import { startCapture } from '../src/capture.ts';
import { createCounterJournal } from '../src/journal.ts';
vi.mock('node:module', async (original) => ({
  ...(await original<typeof import('node:module')>()),
  registerHooks: vi.fn(),
}));
vi.mock('../src/capture.ts', () => ({ startCapture: vi.fn() }));
vi.mock('../src/journal.ts', () => ({ createCounterJournal: vi.fn() }));
const global = globalThis as typeof globalThis & {
  __coverage__?: Record<string, SourceCoverageData>;
};
async function fixture() {
  vi.resetModules();
  const root = mkdtempSync(join(tmpdir(), 'loader-hooks-'));
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const path = 'value.cjs';
  writeFileSync(join(root, path), 'module.exports = 1;');
  const { run } = prepareRun(root, [path], 'revision', ['unit']);
  const config = join(root, 'run.json');
  writeFileSync(config, JSON.stringify({ root, directory: root, run }));
  vi.stubEnv('KOREKAITE_COVERAGE_RUN', config);
  vi.stubEnv('KOREKAITE_COVERAGE_SUITE', 'unit');
  const finish = vi.fn();
  const saved = global.__coverage__;
  vi.mocked(startCapture).mockImplementation(() => {
    delete global.__coverage__;
    return { path: join(root, 'record'), finish };
  });
  vi.mocked(createCounterJournal).mockImplementation(() => saved ?? {});
  const callbacks: (() => void)[] = [];
  const once = process.once.bind(process);
  vi.spyOn(process, 'once').mockImplementation((event, listener) => {
    if (event === 'exit') {
      callbacks.push(listener);
      return process;
    }
    return once(event, listener);
  });
  await import('../src/node-loader.ts');
  return {
    root,
    path,
    finish,
    callbacks,
    hook: vi.mocked(registerHooks).mock.calls.at(-1)![0].load!,
  };
}

test('Nodeローダーは変更された原本を実行前に拒否する', async () => {
  const item = await fixture();
  writeFileSync(join(item.root, item.path), 'module.exports = 2;');
  expect(() =>
    item.hook(
      pathToFileURL(join(item.root, item.path)).href,
      { conditions: [], importAttributes: {}, format: 'commonjs' },
      () => ({ format: 'commonjs', source: '' }),
    ),
  ).toThrow('計測対象が変更されています');
});

test('CommonJS形式を維持して変換結果をNodeへ渡す', async () => {
  const item = await fixture();
  const result = item.hook(
    pathToFileURL(join(item.root, item.path)).href,
    { conditions: [], importAttributes: {}, format: 'commonjs' },
    () => ({ format: 'commonjs', source: '' }),
  );
  expect(result.format).toBe('commonjs');
  expect(result.source).toContain('module.exports = 1');
});

test('終了時にグローバルが消失していても完了処理に空の記録を渡す', async () => {
  const item = await fixture();
  const saved = global.__coverage__;
  try {
    delete global.__coverage__;
    item.callbacks[0]();
    expect(item.finish).toHaveBeenCalledWith({}, 'complete');
  } finally {
    global.__coverage__ = saved;
  }
});

test('計測設定がなければNodeのローダーを登録しない', async () => {
  vi.resetModules();
  vi.stubEnv('KOREKAITE_COVERAGE_RUN', undefined);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  await import('../src/node-loader.ts');
  expect(registerHooks).not.toHaveBeenCalled();
  expect(startCapture).not.toHaveBeenCalled();
});
