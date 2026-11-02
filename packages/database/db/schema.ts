import { sqliteTable, text } from 'void/schema-d1';

export const connectionChecks = sqliteTable('connection_checks', {
  writer: text('writer').primaryKey(),
  value: text('value').notNull(),
});

export { jobs, jobOutbox } from './schema/jobs.ts';
export { diagnosticRequests, diagnosticChecks } from './schema/diagnostics.ts';
