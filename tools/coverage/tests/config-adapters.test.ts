import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, onTestFinished, vi } from 'vitest';
import { prepareRun } from '../src/prepare.ts';
import { runtimeCoveragePlugin } from '../src/runtime-plugin.ts';
import { vitestCoverageConfig } from '../src/vitest-config.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coverage-adapters-'));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'apps/web/src'), { recursive: true });
  const source = 'export const value = 1;';
  writeFileSync(join(root, 'apps/web/src/value.ts'), source);
  const { run } = prepareRun(root, ['apps/web/src/value.ts'], 'revision', ['unit']);
  const config = join(root, 'run.json');
  writeFileSync(config, JSON.stringify({ root, run }));
  return { root, source, config };
}

test('実Worker設定のアダプターはコピーしたWebソースを原本へ対応付ける', () => {
  const { config, source } = fixture();
  vi.stubEnv('KOREKAITE_COVERAGE_RUN', config);
  const plugin = runtimeCoveragePlugin('/copy');
  expect(plugin.transform(source, '/copy/src/value.ts')?.code).toContain('apps/web/src/value.ts');
  expect(plugin.transform(source, '/other/src/value.ts')).toBeUndefined();
});

test('Vitest設定は全プロジェクトへ共通計測と終了時回収を接続する', () => {
  const { root, config } = fixture();
  const value = vitestCoverageConfig(config, ['apps/web', 'tools/coverage']);
  expect(value.test.projects.map((project) => project.test.root)).toEqual([
    join(root, 'apps/web'),
    join(root, 'tools/coverage'),
  ]);
  expect(value.test.projects.every((project) => project.extends)).toBe(true);
  expect(value.test.setupFiles[0]).toMatch(/vitest-setup\.ts$/);
  expect(value.plugins[0].enforce).toBe('pre');
});
