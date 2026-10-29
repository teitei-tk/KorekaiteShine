import { coverageDiagnostic } from './coverage-diagnostic.ts';
import { expect, it } from 'vitest';
import {
  detail,
  validDetail,
  validDiagnostic,
  taskScope,
  renderDiagnostic,
} from './diagnostics.ts';
import { indexSources } from './source-index.ts';
import { planReview } from './partition.ts';

it('固定分類以外と余分な自由文を受け入れない', () => {
  expect(validDetail({ subcode: 'MISSING_CONTEXT', missing: ['CONTRACT'] })).toBe(true);
  for (const value of [
    { subcode: 'SECRET', missing: [] },
    { subcode: 'MISSING_CONTEXT', missing: ['SECRET'] },
    { subcode: 'MISSING_CONTEXT', missing: ['CONTRACT'], text: 'SECRET' },
  ])
    expect(validDetail(value)).toBe(false);
});
it('資料の本文・パスを診断へ含めず、範囲を台帳から取得する', () => {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? `100644 blob ${'c'.repeat(40)}\tSECRET.ts\0`
        : 'export const SECRET = 1;',
    [base, head],
  );
  const plan = planReview({ number: 1, base, head, lines: { 'SECRET.ts': [1] } }, index, [
    { path: 'SECRET.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' },
  ]);
  const diagnostic = {
    ...detail('MISSING_CONTEXT', ['CALLER']),
    scope: taskScope(plan, plan.tasks[0]),
  };
  expect(validDiagnostic(diagnostic)).toBe(true);
  expect(diagnostic.scope?.sources[0]).toMatchObject({ id: plan.sources[0].id, start: 1, end: 1 });
  expect(JSON.stringify(diagnostic)).not.toContain('SECRET');
  expect(renderDiagnostic(diagnostic)).toContain('CALLER');
  expect(renderDiagnostic(diagnostic)).not.toContain('SECRET');
});
it('改ざんした診断や過剰な資料を表示しない', () => {
  const diagnostic = {
    ...detail('MISSING_CONTEXT'),
    scope: {
      kind: 'unit',
      sourceCount: 9,
      obligationCount: 0,
      sources: Array.from({ length: 9 }, () => ({
        id: 'a'.repeat(64),
        start: 1,
        end: 1,
        revisions: ['head'],
      })),
      obligations: [],
    },
  };
  expect(validDiagnostic(diagnostic)).toBe(false);
  expect(() => renderDiagnostic(diagnostic)).toThrow();
});
it('資料が多くても件数を保ち、4KBの状態Artifactへ収める', async () => {
  const { writeStatusReport, readStatusReports } = await import('./status-report.ts');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? Array.from({ length: 12 }, (_, i) => `100644 blob ${'c'.repeat(40)}\tfile${i}.ts\0`).join(
            '',
          )
        : 'export const value = 1;',
    [base, head],
  );
  const plan = planReview({ number: 1, base, head, lines: { 'file0.ts': [1] } }, index, [
    { path: 'file0.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' },
  ]);
  const sources = [
    ...new Map(
      index.files.flatMap((file) => file.sources).map((source) => [source.id, source]),
    ).values(),
  ];
  const scope = taskScope(
    { ...plan, sources },
    { ...plan.tasks[0], sources: sources.map((s) => s.id) },
  );
  expect(scope.sourceCount).toBe(12);
  expect(scope.sources).toHaveLength(8);
  const expected = Array.from({ length: 69 }, (_, i) => i.toString(16).padStart(16, '0'));
  const coverage = coverageDiagnostic(expected, [
    expected[0],
    expected[0],
    expected[1],
    expected[1],
    ...Array.from({ length: 8 }, (_, i) => 'SECRET' + i),
  ]);
  const diagnostic = { ...detail('COVERAGE_MISMATCH', [], coverage), scope };
  const directory = mkdtempSync(join(tmpdir(), 'diagnostic-bound-'));
  try {
    writeStatusReport(
      {
        GITHUB_RUN_ID: '20',
        GITHUB_RUN_ATTEMPT: '1',
        AI_REVIEW_JOB: 'generate',
        AI_REVIEW_REPORT: join(directory, 'status.json'),
      },
      'failure',
      'task-1',
      'INCOMPLETE',
      diagnostic,
    );
    expect(
      Buffer.byteLength(readFileSync(join(directory, 'status.json'), 'utf8')),
    ).toBeLessThanOrEqual(4096);
    expect(readStatusReports(directory, 20, 1)[0].diagnostic).toEqual(diagnostic);
    expect(renderDiagnostic(diagnostic)).toContain('8/12');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('モデル向けSchemaとランタイムの固定分類が一致する', async () => {
  const { modelSubcodes, missingKinds } = await import('./diagnostics.ts');
  const { readFileSync } = await import('node:fs');
  const schema = JSON.parse(
    readFileSync(new URL('./partition-schema.json', import.meta.url), 'utf8'),
  ) as {
    required: string[];
    properties: {
      incomplete: {
        properties: { subcode: { enum: string[] }; missing: { items: { enum: string[] } } };
      };
    };
  };
  expect(schema.required).toContain('incomplete');
  expect([...schema.properties.incomplete.properties.subcode.enum].sort()).toEqual(
    [...modelSubcodes].sort(),
  );
  expect(schema.properties.incomplete.properties.missing.items.enum).toEqual([...missingKinds]);
});
