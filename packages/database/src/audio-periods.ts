import { and, eq, isNotNull, sql } from 'void/db';
import { interviews } from '../db/schema/interviews.ts';
import { audioUsagePeriods, usageReservations } from '../db/schema/usage.ts';
import type { createPrimaryDb } from './connection.ts';

// 状態の更新や削除と同じbatchで、直前のactive区間を一度だけ確定する。
export function closeAudioPeriod(
  db: ReturnType<typeof createPrimaryDb>,
  match: ReturnType<typeof and>,
  now: number | ReturnType<typeof sql<number>>,
) {
  return db
    .insert(audioUsagePeriods)
    .select(
      db
        .select({
          actorId: interviews.actorId,
          interviewId: interviews.interviewId,
          generation: interviews.generation,
          startedAt: sql<number>`${interviews.activeSince}`.as('started_at'),
          endedAt:
            sql<number>`max(${interviews.activeSince}, min(${now}, coalesce(${interviews.deadline}, ${now})))`.as(
              'ended_at',
            ),
        })
        .from(interviews)
        .where(and(match, eq(interviews.status, 'active'), isNotNull(interviews.activeSince))),
    )
    .onConflictDoNothing();
}

export async function usedAudioMs(
  db: ReturnType<typeof createPrimaryDb>,
  actorId: string,
  window: { start: number; end: number; day: string; now: number },
) {
  const { start, end, day, now } = window;
  const row = await db.get<{ ms: number }>(sql`SELECT
    (SELECT coalesce(sum(min(ended_at,${end})-max(started_at,${start})),0) FROM ${audioUsagePeriods}
      WHERE actor_id=${actorId} AND ended_at>${start} AND started_at<${end})
    + (SELECT coalesce(sum(max(0,min(coalesce(deadline,${now}),${now},${end},updated_at)-max(active_since,${start}))),0) FROM ${interviews}
      WHERE actor_id=${actorId} AND status='active' AND active_since IS NOT NULL)
    + (SELECT 1000*coalesce(sum(amount),0) FROM ${usageReservations}
      WHERE actor_id=${actorId} AND kind='audio' AND day=${day}) AS ms`);
  return row.ms;
}
