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
