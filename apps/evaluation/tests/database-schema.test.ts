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
  expect(references).toEqual(
    [
      'diagnostic_checks',
      'diagnostic_requests',
      'execution_slots',
      'job_attempts',
      'job_outbox',
    ].map((table) => ({ table, columns: ['job_id'], target: 'jobs', targetColumns: ['job_id'] })),
  );
  expect(
    configs.flatMap((table) =>
      table.indexes.map(({ config }) => ({
        table: table.name,
        unique: config.unique,
        columns: config.columns.map((column) => ('name' in column ? column.name : 'expression')),
      })),
    ),
  ).toEqual([
    { table: 'delivery_anomalies', unique: true, columns: ['queue_name', 'message_id'] },
    {
      table: 'diagnostic_requests',
      unique: true,
      columns: ['environment', 'actor_id', 'operation', 'idempotency_key'],
    },
    { table: 'dlq_receipts', unique: true, columns: ['queue_name', 'message_id'] },
    { table: 'job_attempts', unique: true, columns: ['job_id', 'attempt_number'] },
    { table: 'job_outbox', unique: true, columns: ['job_id', 'operation', 'generation'] },
  ]);
  expect(configs.flatMap((table) => table.checks.map((check) => check.name))).toEqual([
    'job_attempts_number_range',
    'jobs_attempt_count_range',
  ]);
});
