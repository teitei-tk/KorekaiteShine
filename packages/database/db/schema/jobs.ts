import { sql } from 'void/db';
import { check, integer, sqliteTable, text, uniqueIndex } from 'void/schema-d1';

export const jobs = sqliteTable(
  'jobs',
  {
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
  },
  (table) => [
    check(
      'jobs_attempt_count_range',
      sql`typeof(${table.attemptCount}) = 'integer' AND ${table.attemptCount} BETWEEN 0 AND 4`,
    ),
  ],
);

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

export const executionSlots = sqliteTable('execution_slots', {
  actorId: text('actor_id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => jobs.jobId),
  ownerToken: text('owner_token').notNull(),
  generation: integer('generation').notNull(),
  leaseUntil: integer('lease_until').notNull(),
});

export const jobAttempts = sqliteTable(
  'job_attempts',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.jobId),
    attemptNumber: integer('attempt_number').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    errorCode: text('error_code'),
    resultJson: text('result_json'),
  },
  (table) => [
    uniqueIndex('job_attempts_job_number').on(table.jobId, table.attemptNumber),
    check(
      'job_attempts_number_range',
      sql`typeof(${table.attemptNumber}) = 'integer' AND ${table.attemptNumber} BETWEEN 1 AND 4`,
    ),
  ],
);

// 不在や削除後の通知も記録するため、ジョブへの外部キーは付けない。
export const deliveryAnomalies = sqliteTable(
  'delivery_anomalies',
  {
    queueName: text('queue_name').notNull(),
    messageId: text('message_id').notNull(),
    code: text('code').notNull(),
    expectedPurpose: text('expected_purpose', { enum: ['evaluation', 'diagnostics'] }).notNull(),
    schemaVersion: integer('schema_version'),
    jobId: text('job_id'),
    observedPurpose: text('observed_purpose', { enum: ['evaluation', 'diagnostics'] }),
    firstDetectedAt: integer('first_detected_at').notNull(),
    lastDetectedAt: integer('last_detected_at').notNull(),
    status: text('status', { enum: ['unresolved', 'resolved'] }).notNull(),
    resolution: text('resolution'),
  },
  (table) => [uniqueIndex('delivery_anomalies_queue_message').on(table.queueName, table.messageId)],
);

export const deletedJobs = sqliteTable('deleted_jobs', {
  jobId: text('job_id').primaryKey(),
  deletedAt: integer('deleted_at').notNull(),
});
