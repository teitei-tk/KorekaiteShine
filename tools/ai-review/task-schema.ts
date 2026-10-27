import {
  HISTORY_SUMMARY_CHARS,
  HISTORY_UNCERTAINTIES,
  HISTORY_UNCERTAINTY_CHARS,
} from './output-size.ts';
import { readFileSync } from 'node:fs';
import type { ReviewTask } from './partition.ts';

interface CheckArraySchema {
  type: string;
  minItems?: number;
  maxItems?: number;
  items: {
    properties: {
      id: { type: string; enum?: string[] };
      evidence?: { type: string; maxLength: number };
      sources?: { type: string; maxItems: number; items: { type: string; enum?: string[] } };
    };
  };
}
interface TaskSchema {
  properties: {
    checks: CheckArraySchema;
    checkSources: CheckArraySchema;
    summary: { maxLength?: number };
    uncertainties: { maxItems?: number; items: { maxLength?: number } };
    findings: { maxItems?: number };
    decisions: { maxItems?: number };
    evidence: { maxItems?: number };
    coverage: {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { type: string; enum: boolean[] }>;
    };
  };
}
// 信頼済みのローカルSchemaを毎回読み、作業間で制約を共有しない。
export function taskSchema(task: ReviewTask): TaskSchema {
  const schema = JSON.parse(
    readFileSync(new URL('./partition-schema.json', import.meta.url), 'utf8'),
  ) as TaskSchema;
  schema.properties.coverage = {
    type: 'object',
    additionalProperties: false,
    required: [...task.obligations],
    properties: Object.fromEntries(
      task.obligations.map((id) => [id, { type: 'boolean', enum: [true] }]),
    ),
  };
  if (task.kind === 'history') {
    schema.properties.summary.maxLength = HISTORY_SUMMARY_CHARS;
    schema.properties.uncertainties.maxItems = HISTORY_UNCERTAINTIES;
    schema.properties.uncertainties.items.maxLength = HISTORY_UNCERTAINTY_CHARS;
    for (const key of ['findings', 'decisions', 'evidence'] as const)
      schema.properties[key].maxItems = 0;
    for (const key of ['checks', 'checkSources'] as const) {
      // 根拠の上限はランタイムと共通。資料IDの一覧も担当資料内へ制限する。
      const props = schema.properties[key].items.properties;
      if (key === 'checks') props.evidence = { type: 'string', maxLength: 500 };
      else
        props.sources = {
          type: 'array',
          maxItems: task.sources.length,
          items: { type: 'string', ...(task.sources.length ? { enum: [...task.sources] } : {}) },
        };
    }
  }
  for (const key of ['checks', 'checkSources'] as const) {
    const array = schema.properties[key];
    array.minItems = task.priorIds.length;
    array.maxItems = task.priorIds.length;
    if (task.priorIds.length) array.items.properties.id.enum = [...task.priorIds];
  }
  return schema;
}
