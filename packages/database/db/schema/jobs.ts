import { integer, sqliteTable, text, uniqueIndex } from 'void/schema-d1';

export const jobs = sqliteTable('jobs', {
  jobId: text('job_id').primaryKey(),
  actorId: text('actor_id').notNull(),
  purpose: text('purpose', { enum: ['evaluation', 'diagnostics'] }).notNull(),
  status: text('status', {
    enum: ['pending', 'running', 'retry_wait', 'completed', 'failed', 'cancelled'],
  }).notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  acceptedAt: integer('accepted_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  finishedAt: integer('finished_at'),
  nextAttemptAt: integer('next_attempt_at'),
  lastErrorCode: text('last_error_code'),
  ownerToken: text('owner_token'),
  generation: integer('generation').notNull().default(0),
  leaseUntil: integer('lease_until'),
  attemptDeadline: integer('attempt_deadline'),
});

export const jobOutbox = sqliteTable(
  'job_outbox',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.jobId),
    purpose: text('purpose', { enum: ['evaluation', 'diagnostics'] }).notNull(),
    operation: text('operation', { enum: ['initialize_do', 'notify', 'notify_dlq'] }).notNull(),
    generation: integer('generation').notNull().default(0),
    scheduledAt: integer('scheduled_at').notNull(),
    sentAt: integer('sent_at'),
  },
  (table) => [
    uniqueIndex('job_outbox_operation_generation').on(
      table.jobId,
      table.operation,
      table.generation,
    ),
  ],
);
