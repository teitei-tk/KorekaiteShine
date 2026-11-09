import { expect, test } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { audioUsagePeriods } from '@korekaite/database/usage';
import { remainingAudioMs } from '../src/server/repositories/audio-usage';

test('切断・再接続では稼働区間だけを合算し、日本時間の深夜をまたぐ区間を日ごとに分ける', async () => {
  const database = createTestDatabase();
  try {
    const midnight = 1794063600000;
    await database.db.insert(audioUsagePeriods).values([
      {
        actorId: 'actor',
        interviewId: 'sample',
        generation: 1,
        startedAt: midnight - 1000,
        endedAt: midnight + 2000,
      },
      {
        actorId: 'actor',
        interviewId: 'sample',
        generation: 3,
        startedAt: midnight + 60000,
        endedAt: midnight + 63886,
      },
    ]);
    expect(await remainingAudioMs(database.db, 'actor', midnight + 65000)).toBe(3600000 - 5886);
    expect(await remainingAudioMs(database.db, 'actor', midnight - 1)).toBe(3600000 - 1000);
    expect(await remainingAudioMs(database.db, 'other', midnight + 65000)).toBe(3600000);
  } finally {
    database.close();
  }
});
