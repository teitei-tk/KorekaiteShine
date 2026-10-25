import { readFileSync } from 'node:fs';
import type { ReviewTask } from './partition.ts';

interface CheckArraySchema {
  type: string;
  minItems?: number;
  maxItems?: number;
  items: { properties: { id: { type: string; enum?: string[] } } };
}
interface TaskSchema {
  properties: { checks: CheckArraySchema; checkSources: CheckArraySchema };
}
// 信頼済みのローカルSchemaを毎回読み、作業間で制約を共有しない。
export function taskSchema(task: ReviewTask): TaskSchema {
  const schema = JSON.parse(
    readFileSync(new URL('./partition-schema.json', import.meta.url), 'utf8'),
  ) as TaskSchema;
  for (const key of ['checks', 'checkSources'] as const) {
    const array = schema.properties[key];
    array.minItems = task.priorIds.length;
    array.maxItems = task.priorIds.length;
    if (task.priorIds.length) array.items.properties.id.enum = [...task.priorIds];
  }
  return schema;
}
