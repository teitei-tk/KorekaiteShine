import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createCoverageMap } from '@vitest/istanbul-lib-coverage';
import { expect, test } from 'vitest';
import { instrumentSource } from '../src/instrument.ts';
import { writeReports } from '../src/report.ts';

test('要素0件・未実行・一部実行・4指標100%を区別して出力する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-report-'));
  try {
    const map = createCoverageMap({});
    for (const state of ['zero', 'unexecuted', 'partial', 'complete']) {
      const source =
        state === 'zero'
          ? 'export type Value = string;'
          : 'export function choose(value: boolean) { if (value) return 1; return 2; }';
      const { coverage } = instrumentSource(`${state}.ts`, source);
      if (state === 'complete') {
        for (const key of Object.keys(coverage.s)) {
          coverage.s[key] = 1;
        }
        for (const key of Object.keys(coverage.f)) {
          coverage.f[key] = 1;
        }
        for (const key of Object.keys(coverage.b)) {
          coverage.b[key].fill(1);
        }
      } else if (state === 'partial') {
        coverage.s['0'] = 1;
      }
      map.addFileCoverage(coverage);
    }
    const directory = join(root, 'report');
    await writeReports(map, directory, root);
    const rows = JSON.parse(readFileSync(join(directory, 'files.json'), 'utf8')) as {
      path: string;
      state: string;
      reason?: string;
    }[];
    expect(rows.map(({ path, state }) => [path, state])).toEqual([
      ['complete.ts', 'complete'],
      ['partial.ts', 'partial'],
      ['unexecuted.ts', 'unexecuted'],
      ['zero.ts', 'zero'],
    ]);
    expect(rows.find((row) => row.state === 'zero')?.reason).toContain('計測要素');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('暗黙のelseも分岐番号と条件の元ソース位置を報告する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-implicit-else-'));
  try {
    const { coverage } = instrumentSource(
      'choose.ts',
      'export function choose(value: boolean) {\n  if (value) return 1;\n}',
    );
    coverage.b['0'] = [1, 0];
    const directory = join(root, 'report');
    await writeReports(createCoverageMap({ 'choose.ts': coverage }), directory, root);
    const [row] = JSON.parse(readFileSync(join(directory, 'files.json'), 'utf8'));
    expect(row.missing.branches).toEqual([
      {
        id: '0',
        index: 1,
        type: 'if',
        location: expect.objectContaining({ start: { line: 2, column: 2 } }),
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ソースマップがない元ソースも既定ルートから読み取り報告する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-report-original-'));
  try {
    const source = 'export const value = 1;';
    const path = relative(process.cwd(), join(root, 'value.js'));
    writeFileSync(join(root, 'value.js'), source);
    const { coverage } = instrumentSource(path, source);
    delete coverage.inputSourceMap;
    const result = await writeReports(
      createCoverageMap({ [path]: coverage }),
      join(root, 'report'),
    );
    expect(result.files()).toEqual([path]);
    expect(result.getCoverageSummary().statements.total).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
