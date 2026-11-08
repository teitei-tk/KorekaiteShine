import { Temporal } from '@js-temporal/polyfill';
import { eq, sql } from 'void/db';
import { usageReservations } from '@korekaite/database/usage';
import { usageLimits } from '@korekaite/runtime-config/limits';
import type { createPrimaryDb } from '@korekaite/database/connection';

export async function reserveEvaluation(
  db: ReturnType<typeof createPrimaryDb>,
  input: { jobId: string; actorId: string; now: number },
): Promise<boolean> {
  const reservationId = `evaluation:${input.jobId}`;
  const day = Temporal.Instant.fromEpochMilliseconds(input.now)
    .toZonedDateTimeISO(usageLimits.timeZone)
    .toPlainDate()
    .toString();
  await db.run(sql`
    INSERT INTO ${usageReservations} (reservation_id, actor_id, day, kind, amount, created_at)
    SELECT ${reservationId}, ${input.actorId}, ${day}, 'evaluation', 1, ${input.now}
    WHERE (
      SELECT COALESCE(SUM(${usageReservations.amount}), 0) FROM ${usageReservations}
      WHERE ${usageReservations.actorId} = ${input.actorId}
        AND ${usageReservations.day} = ${day} AND ${usageReservations.kind} = 'evaluation'
    ) < ${usageLimits.evaluationsPerDay}
    ON CONFLICT DO NOTHING
  `);
  const [saved] = await db
    .select()
    .from(usageReservations)
    .where(eq(usageReservations.reservationId, reservationId));
  // 再試行は初回の予約を引き継ぐ。翌日の新規枠をもう一度消費しない。
  return Boolean(
    saved && saved.actorId === input.actorId && saved.kind === 'evaluation' && saved.amount === 1,
  );
}
