import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createCoverageMap, type FileCoverageData } from '@vitest/istanbul-lib-coverage';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, test } from 'vitest';
import { instrumentSource } from '../src/instrument.ts';
import { branchFixture } from './fixtures/branches.ts';

test('Node子プロセスとWorkerの記録を重複なく統合し、未呼び出し関数を残す', async () => {
  const path = 'branches.ts';
  const { code, coverage } = instrumentSource(path, branchFixture);
  const node = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      code +
        `
import { writeSync } from 'node:fs';
choose(); select(); label(true);
try { await fail(true); } catch {}
writeSync(1, JSON.stringify(globalThis.__coverage__['branches.ts']));
`,
    ],
    // 人工的なfixtureの計測は、このテスト自身が回収する。
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
  );
  expect(node.error).toBeUndefined();
  expect(node.status, node.stderr).toBe(0);
  const nodeCoverage: FileCoverageData = JSON.parse(node.stdout);
  const vmCoverage: FileCoverageData = await runInNewContext(
    code +
      `
(async () => {
  choose(); select(); label(true);
  try { await fail(true); } catch {}
  return globalThis.__coverage__['branches.ts'];
})()
`,
  );
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'coverage-fixture',
          modules: true,
          compatibilityDate: '2026-10-19',
          script:
            code +
            `
export default { async fetch() {
  choose(false); select(1); label(false); await fail(false);
  return Response.json(globalThis.__coverage__['branches.ts']);
} }`,
        },
      ],
    }),
  );
  try {
    const response = await worker.dispatchFetch('http://localhost');
    const workerCoverage = (await response.json()) as FileCoverageData;
    for (const record of [nodeCoverage, vmCoverage, workerCoverage]) {
      for (const key of ['statementMap', 'fnMap', 'branchMap'] as const) {
        expect(JSON.parse(JSON.stringify(record[key]))).toEqual(
          JSON.parse(JSON.stringify(coverage[key])),
        );
      }
    }
    const combined = createCoverageMap({ [path]: nodeCoverage });
    combined.merge({ [path]: vmCoverage });
    combined.merge({ [path]: workerCoverage });
    const summary = combined.getCoverageSummary();
    expect(summary.lines).toMatchObject({ total: 7, covered: 6 });
    expect(summary.statements).toMatchObject({ total: 9, covered: 8 });
    expect(summary.functions).toMatchObject({ total: 5, covered: 4 });
    expect(summary.branches).toMatchObject({ total: 9, covered: 9 });
    expect(
      Object.values(combined.fileCoverageFor(path).b)
        .flat()
        .every((count) => count >= 0),
    ).toBe(true);
  } finally {
    await worker.dispose();
  }
});
