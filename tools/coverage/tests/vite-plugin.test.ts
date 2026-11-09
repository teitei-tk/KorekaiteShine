import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import { coveragePlugin } from '../src/vite-plugin.ts';
import { createMergeFixture } from './fixtures/measurement.ts';

test('台帳作成後の原本変更をVite変換で拒否する', () => {
  const { run, target, path } = createMergeFixture();
  const plugin = coveragePlugin('/repo', run);
  const source = target.coverage.inputSourceMap!.sourcesContent![0]!;
  expect(() => plugin.transform(source + '\nchoose(true);', `/repo/${path}`)).toThrow(
    '計測対象が変更されています',
  );
});

test('Vite変換で原本と同じ計測位置を使い対象外には触れない', () => {
  const { run, path, target } = createMergeFixture();
  const source = target.coverage.inputSourceMap!.sourcesContent![0]!;
  const plugin = coveragePlugin('/repo', run);
  expect(plugin.enforce).toBe('pre');
  expect(
    plugin.transform('export const untouched = 1;', '/repo/node_modules/x/index.js'),
  ).toBeUndefined();
  const transformed = plugin.transform(source, `/repo/${path}`)!;
  const data = runInNewContext(`${transformed.code}\nchoose(true); globalThis.__coverage__`);
  expect(data[path].statementMap).toEqual(target.coverage.statementMap);
  expect(data[path].f['0']).toBe(1);
  expect(transformed.map.sources).toEqual([`/repo/${path}`]);
});

test('コピー先は内容が一致する原本だけへ対応付け、生成された置換ファイルを混ぜない', () => {
  const { run, target } = createMergeFixture();
  const source = target.coverage.inputSourceMap!.sourcesContent![0]!;
  const plugin = coveragePlugin('/repo', run, [{ from: '/copy/src', to: '/repo/src' }]);
  expect(plugin.transform(source, '/copy/src/choose.ts')?.code).toContain('__coverage__');
  expect(plugin.transform(source + '\nchoose(true);', '/copy/src/choose.ts')).toBeUndefined();
  expect(plugin.transform(source, '/copy/other/choose.ts')).toBeUndefined();
});
