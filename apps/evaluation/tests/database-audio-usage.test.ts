import { expect, test } from 'vitest';
import { eq } from 'void/db';
import { audioUsagePeriods, interviews, usageReservations } from '@korekaite/database';
import { closeAudioPeriod, usedAudioMs } from '../../../packages/database/src/audio-periods.ts';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { snapshot } from './fixtures/evaluation';

test('日付の境界で音声区間を切り、確定時は重複なく予約分と合計する', async () => {
  const fixture = createTestDatabase();
  try {
    const { interviewId } = snapshot.interview;
    await fixture.db.insert(interviews).values({
      ...snapshot.interview,
      actorId: 'actor',
      status: 'active',
      activeSince: 100,
      deadline: 500,
      generation: 1,
      updatedAt: 100,
      createdAt: 0,
    });
    await fixture.db.insert(usageReservations).values({
      reservationId: 'one',
      actorId: 'actor',
      kind: 'audio',
      amount: 2,
      day: '2026-11-09',
      createdAt: 100,
    });
    const window = { day: '2026-11-09', start: 200, end: 600, now: 700 };
    const owned = eq(interviews.interviewId, interviewId);
    // 最終稼働確認が集計窓より前なら、未確定区間はまだ加算しない。
    expect(await usedAudioMs(fixture.db, 'actor', window)).toBe(2000);
    await fixture.db.update(interviews).set({ updatedAt: 400 }).where(owned);
    expect(await usedAudioMs(fixture.db, 'actor', window)).toBe(2200);
    await fixture.db.update(interviews).set({ updatedAt: 600 }).where(owned);
    expect(await usedAudioMs(fixture.db, 'actor', window)).toBe(2300);
    await fixture.db.batch([
      closeAudioPeriod(fixture.db, owned, 700),
      closeAudioPeriod(fixture.db, owned, 700),
      fixture.db.update(interviews).set({ activeSince: null, status: 'ended' }).where(owned),
    ]);
    expect(await fixture.db.select().from(audioUsagePeriods)).toMatchObject([
      { startedAt: 100, endedAt: 500 },
    ]);
    expect(await usedAudioMs(fixture.db, 'actor', window)).toBe(2300);
    expect(await usedAudioMs(fixture.db, 'other', window)).toBe(0);
  } finally {
    fixture.close();
  }
});
