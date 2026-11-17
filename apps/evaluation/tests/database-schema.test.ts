import { expect, test } from 'vitest';
import { getTableConfig } from 'void/schema-d1';
import * as schema from '@korekaite/database';

test('DB定義はジョブ参照と冪等性の一意制約を保持し、隔離記録には外部キーを課さない', () => {
  const configs = Object.values(schema)
    .map((table) => getTableConfig(table))
    .sort((left, right) => left.name.localeCompare(right.name));
  const references = configs.flatMap((table) =>
    table.foreignKeys.map((key) => {
      const reference = key.reference();
      return {
        table: table.name,
        columns: reference.columns.map((column) => column.name),
        target: getTableConfig(reference.foreignTable).name,
        targetColumns: reference.foreignColumns.map((column) => column.name),
      };
    }),
  );
  expect(references).toEqual([
    { table: 'diagnostic_checks', columns: ['job_id'], target: 'jobs', targetColumns: ['job_id'] },
    {
      table: 'diagnostic_requests',
      columns: ['job_id'],
      target: 'jobs',
      targetColumns: ['job_id'],
    },
    { table: 'evaluation_inputs', columns: ['job_id'], target: 'jobs', targetColumns: ['job_id'] },
    {
      table: 'evaluation_inputs',
      columns: ['interview_id'],
      target: 'interviews',
      targetColumns: ['interview_id'],
    },
    { table: 'execution_slots', columns: ['job_id'], target: 'jobs', targetColumns: ['job_id'] },
    { table: 'job_attempts', columns: ['job_id'], target: 'jobs', targetColumns: ['job_id'] },
    { table: 'job_outbox', columns: ['job_id'], target: 'jobs', targetColumns: ['job_id'] },
    {
      table: 'playback_receipts',
      columns: ['interview_id'],
      target: 'interviews',
      targetColumns: ['interview_id'],
    },
    {
      table: 'transcript_fragments',
      columns: ['interview_id'],
      target: 'interviews',
      targetColumns: ['interview_id'],
    },
  ]);
  expect(
    configs.flatMap((table) =>
      table.indexes.map(({ config }) => ({
        table: table.name,
        unique: config.unique,
        columns: config.columns.map((column) => ('name' in column ? column.name : 'expression')),
      })),
    ),
  ).toEqual([
    { table: 'audio_usage_periods', unique: true, columns: ['interview_id', 'generation'] },
    { table: 'audio_usage_periods', unique: false, columns: ['actor_id', 'ended_at'] },
    { table: 'delivery_anomalies', unique: true, columns: ['queue_name', 'message_id'] },
    {
      table: 'diagnostic_requests',
      unique: true,
      columns: ['environment', 'actor_id', 'operation', 'idempotency_key'],
    },
    { table: 'dlq_receipts', unique: true, columns: ['queue_name', 'message_id'] },
    { table: 'evaluation_inputs', unique: true, columns: ['retry_of'] },
    { table: 'evaluation_inputs', unique: true, columns: ['interview_id'] },
    { table: 'interviews', unique: true, columns: ['actor_id'] },
    { table: 'job_attempts', unique: true, columns: ['job_id', 'attempt_number'] },
    { table: 'job_outbox', unique: true, columns: ['job_id', 'operation', 'generation'] },
    { table: 'material_analyses', unique: false, columns: ['expires_at'] },
    { table: 'playback_receipts', unique: true, columns: ['interview_id', 'generation'] },
    { table: 'transcript_fragments', unique: true, columns: ['interview_id', 'sequence'] },
    {
      table: 'transcript_fragments',
      unique: true,
      columns: ['interview_id', 'generation', 'source_event_id'],
    },
    { table: 'usage_reservations', unique: false, columns: ['actor_id', 'day', 'kind'] },
  ]);
  expect(configs.flatMap((table) => table.checks.map((check) => check.name))).toEqual([
    'audio_usage_period_order',
    'evaluation_inputs_kind',
    'evaluation_inputs_sequence',
    'evaluation_inputs_json',
    'interviews_status',
    'interviews_counters',
    'job_attempts_number_range',
    'jobs_attempt_count_range',
    'material_analyses_json',
    'material_analyses_expiry',
    'playback_receipts_counters',
    'transcript_fragments_speaker',
    'transcript_fragments_counters',
    'usage_reservations_kind',
    'usage_reservations_amount',
  ]);
});
