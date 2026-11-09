import { Temporal } from '@js-temporal/polyfill';
import { eq, sql } from 'void/db';
import { usageReservations } from '@korekaite/database/usage';
import { usageLimits } from '@korekaite/runtime-config/limits';
import type { createPrimaryDb } from '@korekaite/database/connection';

export async function reserveAnalysis(
  db: ReturnType<typeof createPrimaryDb>,
  input: { reservationId: string; actorId: string; now: number },
): Promise<boolean> {
  const day = Temporal.Instant.fromEpochMilliseconds(input.now)
    .toZonedDateTimeISO(usageLimits.timeZone)
    .toPlainDate()
    .toString();
  await db.run(sql`
    INSERT INTO ${usageReservations} (reservation_id, actor_id, day, kind, amount, created_at)
    SELECT ${input.reservationId}, ${input.actorId}, ${day}, 'analysis', 1, ${input.now}
    WHERE (
      SELECT COALESCE(SUM(${usageReservations.amount}), 0) FROM ${usageReservations}
      WHERE ${usageReservations.actorId} = ${input.actorId}
        AND ${usageReservations.day} = ${day} AND ${usageReservations.kind} = 'analysis'
    ) < ${usageLimits.analysesPerDay}
    ON CONFLICT DO NOTHING
  `);
  const [saved] = await db
    .select()
    .from(usageReservations)
    .where(eq(usageReservations.reservationId, input.reservationId));
  return Boolean(
    saved &&
    saved.actorId === input.actorId &&
    saved.day === day &&
    saved.kind === 'analysis' &&
    saved.amount === 1,
  );
}
