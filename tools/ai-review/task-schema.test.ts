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
