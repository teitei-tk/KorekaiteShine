import { runInNewContext } from 'node:vm';
import { createFileCoverage, type FileCoverageData } from '@vitest/istanbul-lib-coverage';
import { transformSync } from 'rolldown/utils';
import { expect, test } from 'vitest';
import { instrumentSource } from '../src/instrument.ts';

test('未実行のTypeScript関数も4指標の分母へ含める', () => {
  const source = [
    'export function choose(value: boolean): number {',
    '  if (value) {',
    '    return 1;',
    '  }',
    '  return 2;',
    '}',
  ].join('\n');
  const result = instrumentSource('fixture.ts', source);
  const summary = createFileCoverage(result.coverage).toSummary();

  expect(summary.lines).toMatchObject({ total: 3, covered: 0 });
  expect(summary.statements).toMatchObject({ total: 3, covered: 0 });
  expect(summary.functions).toMatchObject({ total: 1, covered: 0 });
  expect(summary.branches).toMatchObject({ total: 2, covered: 0 });
  expect(result.code).toContain('__coverage__');
});

test('TSXの型を除去しても画面の両分岐を計測できる', () => {
  const source = ['const C = ({ok}: {ok: boolean}) =>', '  <div>{ok ? 1 : 2}</div>;'].join('\n');
  const result = instrumentSource('fixture.tsx', source);
  const executable = transformSync('fixture.jsx', result.code, {
    jsx: { runtime: 'classic', pragma: 'h' },
  });
  expect(executable.errors).toEqual([]);
  const scope = {
    h: (_tag: string, _props: null, child: number) => child,
    __coverage__: {} as Record<string, FileCoverageData>,
  };
  expect(runInNewContext(executable.code + '\n[C({ok:true}), C({ok:false})]', scope)).toEqual([
    1, 2,
  ]);
  const summary = createFileCoverage(scope.__coverage__['fixture.tsx']).toSummary();
  expect(summary.statements).toMatchObject({ total: 2, covered: 2 });
  expect(summary.functions).toMatchObject({ total: 1, covered: 1 });
  expect(summary.branches).toMatchObject({ total: 2, covered: 2 });
  expect(summary.lines.covered).toBe(summary.lines.total);
});

test('構文エラーを計測要素0件として受け入れない', () => {
  expect(() => instrumentSource('broken.ts', 'export const = ;')).toThrow(
    '計測対象の変換に失敗しました: broken.ts',
  );
});

test('計測後コードから元のTypeScriptへのsource mapを返す', () => {
  const source = 'export const answer: number = 42;';
  const result = instrumentSource('src/answer.ts', source);
  expect(result.map).toMatchObject({
    version: 3,
    sources: ['src/answer.ts'],
    sourcesContent: [source],
  });
  expect(result.map?.mappings.length).toBeGreaterThan(0);
});
