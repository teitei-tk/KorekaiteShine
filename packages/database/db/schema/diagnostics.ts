import { integer, sqliteTable, text, uniqueIndex } from 'void/schema-d1';
import { jobs } from './jobs.ts';

export const diagnosticRequests = sqliteTable(
  'diagnostic_requests',
  {
    id: text('id').primaryKey(),
    environment: text('environment').notNull(),
    actorId: text('actor_id').notNull(),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    scenario: text('scenario', {
      enum: ['success', 'retry_then_success', 'exhaust_retries'],
    }).notNull(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.jobId),
    acceptedAt: integer('accepted_at').notNull(),
  },
  (table) => [
    uniqueIndex('diagnostic_requests_scope_key').on(
      table.environment,
      table.actorId,
      table.operation,
      table.idempotencyKey,
    ),
  ],
);

export const diagnosticChecks = sqliteTable('diagnostic_checks', {
  jobId: text('job_id')
    .primaryKey()
    .references(() => jobs.jobId),
  scenario: text('scenario', {
    enum: ['success', 'retry_then_success', 'exhaust_retries'],
  }).notNull(),
  firstReceivedAt: integer('first_received_at'),
  doPersistence: text('do_persistence', { enum: ['pending', 'passed', 'not_expected'] }).notNull(),
  consumerCompletion: text('consumer_completion', {
    enum: ['pending', 'passed', 'not_expected'],
  }).notNull(),
  dlqReceipt: text('dlq_receipt', { enum: ['pending', 'passed', 'not_expected'] }).notNull(),
});
