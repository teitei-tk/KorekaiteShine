import { usedAudioMs } from '@korekaite/database/audio-periods';
import { Temporal } from '@js-temporal/polyfill';
import { usageLimits } from '@korekaite/runtime-config/limits';
import type { createPrimaryDb } from '@korekaite/database/connection';

// 開始判定時には同じ本人のactive区間はない（本人につき進行中の面接1件、DOで直列化）。
async function audioBudget(db: ReturnType<typeof createPrimaryDb>, actor: string, now: number) {
  const start = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(usageLimits.timeZone)
    .startOfDay();
  const from = start.epochMilliseconds,
    until = start.add({ days: 1 }).epochMilliseconds;
  const used = await usedAudioMs(db, actor, {
    start: from,
    end: until,
    day: start.toPlainDate().toString(),
    now,
  });
  return { remainingMs: Math.max(0, usageLimits.audioSecondsPerDay * 1000 - used), end: until };
}

export async function remainingAudioMs(
  db: ReturnType<typeof createPrimaryDb>,
  actor: string,
  now: number,
) {
  return (await audioBudget(db, actor, now)).remainingMs;
}

export async function dailyAudioDeadline(
  db: ReturnType<typeof createPrimaryDb>,
  actor: string,
  now: number,
) {
  const { remainingMs, end } = await audioBudget(db, actor, now);
  // 深夜まで使えるなら翌日の60分枠が始まる。1面接の上限20分は状態遷移が管理する。
  return now + remainingMs < end ? now + remainingMs : undefined;
}
