import { sql } from 'void/db';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'void/schema-d1';

export const usageReservations = sqliteTable(
  'usage_reservations',
  {
    reservationId: text('reservation_id').primaryKey(),
    actorId: text('actor_id').notNull(),
    day: text('day').notNull(),
    kind: text('kind', { enum: ['analysis', 'audio', 'evaluation'] }).notNull(),
    amount: integer('amount').notNull(),
    createdAt: integer('created_at').notNull(),
    settledAt: integer('settled_at'),
  },
  (table) => [
    index('usage_reservations_actor_day_kind').on(table.actorId, table.day, table.kind),
    check('usage_reservations_kind', sql`${table.kind} IN ('analysis', 'audio', 'evaluation')`),
    check(
      'usage_reservations_amount',
      sql`typeof(${table.amount}) = 'integer' AND ${table.amount} >= 0`,
    ),
  ],
);

// 面接記録を削除しても、その日に利用した時間は保持する。
export const audioUsagePeriods = sqliteTable(
  'audio_usage_periods',
  {
    actorId: text('actor_id').notNull(),
    interviewId: text('interview_id').notNull(),
    generation: integer('generation').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at').notNull(),
  },
  (table) => [
    uniqueIndex('audio_usage_period_generation').on(table.interviewId, table.generation),
    index('audio_usage_period_actor_end').on(table.actorId, table.endedAt),
    check('audio_usage_period_order', sql`${table.endedAt} >= ${table.startedAt}`),
  ],
);
