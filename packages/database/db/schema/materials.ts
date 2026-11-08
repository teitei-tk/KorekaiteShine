import { sql } from 'void/db';
import { check, index, integer, sqliteTable, text } from 'void/schema-d1';

export const materialAnalyses = sqliteTable(
  'material_analyses',
  {
    analysisId: text('analysis_id').primaryKey(),
    actorId: text('actor_id').notNull(),
    materialHash: text('material_hash').notNull(),
    candidatesJson: text('candidates_json').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    index('material_analyses_expiry').on(table.expiresAt),
    check('material_analyses_json', sql`json_valid(${table.candidatesJson})`),
    check('material_analyses_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);
