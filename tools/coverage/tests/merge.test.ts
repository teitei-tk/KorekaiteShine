import { expect, test } from 'vitest';
import { mergeMeasurements } from '../src/merge.ts';
import { createMergeFixture } from './fixtures/measurement.ts';

test('別経路の記録を同じ分母で統合し、未実行の台帳を変更しない', () => {
  const { path, target, run, records } = createMergeFixture();
  const combined = mergeMeasurements(run, records);
  const summary = combined.getCoverageSummary();
  expect(combined.files()).toEqual([path]);
  expect(summary.lines).toMatchObject({ total: 3, covered: 3 });
  expect(summary.statements).toMatchObject({ total: 3, covered: 3 });
  expect(summary.functions).toMatchObject({ total: 1, covered: 1 });
  expect(summary.branches).toMatchObject({ total: 2, covered: 2 });
  expect(combined.fileCoverageFor(path).b['0']).toEqual([1, 1]);
  expect(combined.fileCoverageFor(path).f['0']).toBe(2);
  expect(Object.values(target.coverage.s)).toEqual([0, 0, 0]);
});

test('非負の安全な整数でない実行回数を拒否する', () => {
  for (const value of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    for (const kind of ['s', 'f', 'b'] as const) {
      const { run, records } = createMergeFixture();
      const coverage = records[0].files[0].coverage;
      if (kind === 'b') {
        coverage.b['0'][0] = value;
      } else {
        coverage[kind]['0'] = value;
      }
      expect(() => mergeMeasurements(run, records)).toThrow('不正な実行回数: src/choose.ts');
    }
  }
});

test('文・関数・分岐の計測位置が台帳と異なる記録を拒否する', () => {
  for (const kind of ['statement', 'function', 'branch'] as const) {
    const { run, records } = createMergeFixture();
    const coverage = records[0].files[0].coverage;
    if (kind === 'statement') {
      coverage.statementMap['0'].start.line += 1;
    } else if (kind === 'function') {
      coverage.fnMap['0'].loc.start.line += 1;
    } else {
      coverage.branchMap['0'].locations[0].start.line += 1;
    }
    expect(() => mergeMeasurements(run, records)).toThrow('計測位置が一致しません: src/choose.ts');
  }
});

test('ソースのハッシュが台帳と異なる記録を拒否する', () => {
  const { run, records } = createMergeFixture();
  records[0].files[0].sourceHash = 'b'.repeat(64);
  expect(() => mergeMeasurements(run, records)).toThrow(
    'ソースのハッシュが一致しません: src/choose.ts',
  );
});

test('計測コードのハッシュが台帳と異なる記録を拒否する', () => {
  const { run, records } = createMergeFixture();
  records[0].files[0].instrumentationHash = 'b'.repeat(64);
  expect(() => mergeMeasurements(run, records)).toThrow(
    '計測コードのハッシュが一致しません: src/choose.ts',
  );
});

test('同じ計測片の重複を拒否して実行回数の二重加算を防ぐ', () => {
  const { run, records } = createMergeFixture();
  expect(() => mergeMeasurements(run, [...records, records[0]])).toThrow(
    '計測片が重複しています: capture-0',
  );
});

test('必須suiteの記録が欠けた集計を拒否する', () => {
  const { run, records } = createMergeFixture();
  expect(() => mergeMeasurements(run, records.slice(0, 1))).toThrow(
    '必須suiteが欠落しています: worker',
  );
});

test('失敗または未完了の収集を正常な記録として扱わない', () => {
  for (const status of ['failed', 'incomplete'] as const) {
    const { run, records } = createMergeFixture();
    records[0].status = status;
    expect(() => mergeMeasurements(run, records)).toThrow('収集が完了していません: capture-0');
  }
});

test('別の実行・リビジョン・形式・suiteの計測片を混入させない', () => {
  for (const patch of [
    { runId: 'old-run' },
    { revision: 'old-revision' },
    { formatVersion: 2 },
    { suite: 'unknown' },
  ]) {
    const { run, records } = createMergeFixture();
    Object.assign(records[0], patch);
    expect(() => mergeMeasurements(run, records)).toThrow(
      '計測片の識別情報が一致しません: capture-0',
    );
  }
});

test('台帳のファイルがどの収集結果にもない場合は欠落を報告する', () => {
  const { run, records } = createMergeFixture();
  const emptyRecords = records.map((record) => ({ ...record, files: [] }));
  expect(() => mergeMeasurements(run, emptyRecords)).toThrow(
    'ファイルの計測記録が欠落しています: src/choose.ts',
  );
});

test('欠落または余分なカウンターと分岐数の不一致を拒否する', () => {
  for (const kind of ['s', 'f', 'b'] as const) {
    for (const extra of [false, true]) {
      const { run, records } = createMergeFixture();
      const coverage = records[0].files[0].coverage;
      if (extra) {
        if (kind === 'b') {
          coverage.b['unexpected'] = [0];
        } else {
          coverage[kind]['unexpected'] = 0;
        }
      } else {
        delete coverage[kind]['0'];
      }
      expect(() => mergeMeasurements(run, records)).toThrow(
        'カウンターの構造が一致しません: src/choose.ts',
      );
    }
  }
  const { run, records } = createMergeFixture();
  records[0].files[0].coverage.b['0'].pop();
  expect(() => mergeMeasurements(run, records)).toThrow(
    'カウンターの構造が一致しません: src/choose.ts',
  );
});

test('計測片内で同じファイルが重複しても二重加算しない', () => {
  const { run, records } = createMergeFixture();
  records[0].files = [...records[0].files, records[0].files[0]];
  expect(() => mergeMeasurements(run, records)).toThrow(
    '計測片内のファイルが重複しています: src/choose.ts',
  );
});
