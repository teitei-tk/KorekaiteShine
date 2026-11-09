import { sqliteTable, text } from 'void/schema-d1';

export const connectionChecks = sqliteTable('connection_checks', {
  writer: text('writer').primaryKey(),
  value: text('value').notNull(),
});

export {
  jobs,
  jobOutbox,
  executionSlots,
  jobAttempts,
  deliveryAnomalies,
  deletedJobs,
  dlqReceipts,
} from './schema/jobs.ts';
export { diagnosticRequests, diagnosticChecks } from './schema/diagnostics.ts';
export { materialAnalyses } from './schema/materials.ts';
export {
  interviews,
  transcriptFragments,
  playbackReceipts,
  evaluationInputs,
  deletedInterviews,
  type EvaluationConfiguration,
  type EvaluationSnapshot,
} from './schema/interviews.ts';

export { usageReservations, audioUsagePeriods } from './schema/usage.ts';
