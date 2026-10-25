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
it('39件の確認対象を担当IDと件数で制約し、別作業へ持ち越さない', () => {
  const obligations = Array.from({ length: 39 }, (_, i) => i.toString(16).padStart(16, '0'));
  const coverage = taskSchema({ ...task, obligations }).properties.coverage;
  expect(coverage.items.enum).toEqual(obligations);
  expect(coverage.minItems).toBe(39);
  expect(coverage.maxItems).toBe(39);
  const next = taskSchema({ ...task, obligations: ['f'.repeat(16)] }).properties.coverage;
  expect(next.items.enum).toEqual(['f'.repeat(16)]);
  expect(next.minItems).toBe(1);
  expect(next.maxItems).toBe(1);
  const empty = taskSchema(task).properties.coverage;
  expect(empty.minItems).toBe(0);
  expect(empty.maxItems).toBe(0);
  expect(empty.items.enum).toBeUndefined();
});
