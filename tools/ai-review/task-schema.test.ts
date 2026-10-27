import { expect, it } from 'vitest';
import { taskSchema } from './task-schema.ts';
import type { ReviewTask } from './partition.ts';

const task: ReviewTask = { id: 'task-1', kind: 'unit', sources: [], obligations: [], priorIds: [] };
it('履歴担当のない作業ではchecksとcheckSourcesを空配列へ制限する', () => {
  const schema = taskSchema(task);
  for (const key of ['checks', 'checkSources'] as const) {
    expect(schema.properties[key].maxItems).toBe(0);
    expect(schema.properties[key].minItems).toBe(0);
  }
});
it('履歴作業は担当IDと件数をSchemaへ固定し、他の呼び出しへ持ち越さない', () => {
  const schema = taskSchema({ ...task, kind: 'history', priorIds: ['9:1', '10:1'] });
  for (const key of ['checks', 'checkSources'] as const) {
    expect(schema.properties[key].items.properties.id.enum).toEqual(['9:1', '10:1']);
    expect(schema.properties[key].minItems).toBe(2);
    expect(schema.properties[key].maxItems).toBe(2);
    expect(taskSchema(task).properties[key].items.properties.id.enum).toBeUndefined();
  }
});
it('69件の確認対象を必須のオブジェクトキーとして固定する', () => {
  const obligations = Array.from({ length: 69 }, (_, i) => i.toString(16).padStart(16, '0'));
  const coverage = taskSchema({ ...task, obligations }).properties.coverage;
  expect(coverage.type).toBe('object');
  expect(coverage.required).toEqual(obligations);
  expect(Object.keys(coverage.properties)).toEqual(obligations);
  expect(coverage.additionalProperties).toBe(false);
  for (const value of Object.values(coverage.properties))
    expect(value).toEqual({ type: 'boolean', enum: [true] });
  expect(taskSchema(task).properties.coverage.required).toEqual([]);
  expect(taskSchema(task).properties.coverage.properties).toEqual({});
});
it('履歴応答の文字数・根拠資料件数をSchemaへ制約する', () => {
  const schema = taskSchema({
    ...task,
    kind: 'history',
    priorIds: ['1:1'],
    sources: ['a'.repeat(64)],
  });
  expect(schema.properties.summary.maxLength).toBe(300);
  expect(schema.properties.uncertainties.maxItems).toBe(3);
  expect(schema.properties.uncertainties.items.maxLength).toBe(150);
  expect(schema.properties.checks.items.properties.evidence?.maxLength).toBe(500);
  expect(schema.properties.checkSources.items.properties.sources?.maxItems).toBe(1);
  expect(schema.properties.findings.maxItems).toBe(0);
});

it('指摘位置は担当するhead資料の変更行だけをSchemaで許可する', () => {
  const plan: import('./partition.ts').ReviewPlan = {
    version: 1,
    obligations: [{ id: 'o', kind: 'unit', sources: ['a', 'd'], context: [] }],
    tasks: [],
    excluded: [],
    metadata: {
      number: 1,
      base: 'base',
      head: 'h',
      lines: { 'a.ts': [2, 3, 5, 100], 'deleted.ts': [1] },
    },
    sources: [
      { content: '', id: 'a', path: 'a.ts', revisions: ['h'], start: 1, end: 10 },
      { content: '', id: 'd', path: 'deleted.ts', revisions: ['base'], start: 1, end: 10 },
    ],
  };
  const schema = taskSchema({ ...task, obligations: ['o'], sources: ['a', 'd'] }, plan);
  expect(schema.properties.findings.items).toMatchObject({
    anyOf: [
      {
        properties: {
          path: { enum: ['a.ts'] },
          line: {
            anyOf: [
              { type: 'integer', minimum: 2, maximum: 3 },
              { type: 'integer', minimum: 5, maximum: 5 },
            ],
          },
        },
      },
    ],
  });
  expect(taskSchema({ ...task, sources: ['d'] }, plan).properties.findings.maxItems).toBe(0);
});

it('300ファイルの共通依存変更でもSchemaのenum総数をAPI上限内に保つ', async () => {
  const { indexSources } = await import('./source-index.ts');
  const { planReview } = await import('./partition.ts');
  const files = Object.fromEntries([
    ['common.ts', 'export const common=1;'],
    ...Array.from({ length: 300 }, (_, i) => [
      `f${i}.ts`,
      "import {common} from './common.ts';\nexport const value=common;",
    ]),
  ]);
  const names = Object.keys(files);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? names.map((p, i) => `100644 blob ${i.toString(16).padStart(40, '0')}\t${p}\0`).join('')
        : files[names[parseInt(args.at(-1)!, 16)]],
    ['a'.repeat(40)],
  );
  const plan = planReview(
    {
      number: 1,
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      lines: Object.fromEntries(names.map((p) => [p, [1, 2]])),
    },
    index,
    names.map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new\n' })),
  );
  type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
  const enumCount = (value: Json): number =>
    Array.isArray(value)
      ? value.reduce<number>((n, item) => n + enumCount(item), 0)
      : value && typeof value === 'object'
        ? Object.entries(value).reduce(
            (n, [key, item]) =>
              n + (key === 'enum' && Array.isArray(item) ? item.length : enumCount(item)),
            0,
          )
        : 0;
  for (const task of plan.tasks)
    expect(
      enumCount(JSON.parse(JSON.stringify(taskSchema(task, plan))) as Json),
    ).toBeLessThanOrEqual(1000);
}, 30_000);
