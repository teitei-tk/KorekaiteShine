import { expect, test } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { reserveAnalysis } from '../src/server/repositories/analysis-usage';

test('分析枠を日本時間の日付で原子的に予約し、再送を重複計上しない', async () => {
  const database = createTestDatabase();
  try {
    // 2026-11-07 23:59:59 JST
    const now = 1794063599000;
    const reserve = (id: string, actor = 'actor', at = now) =>
      reserveAnalysis(database.db, { reservationId: id, actorId: actor, now: at });
    const accepted = await Promise.all(
      Array.from({ length: 12 }, (_, index) => reserve(`r-${index}`)),
    );
    expect(accepted.filter(Boolean)).toHaveLength(10);
    expect(await reserve('r-0')).toBe(true);
    expect(await reserve('r-0', 'other')).toBe(false);
    expect(await reserve('r-extra')).toBe(false);
    expect(await reserve('other', 'other')).toBe(true);
    expect(await reserve('tomorrow', 'actor', now + 1000)).toBe(true);
  } finally {
    database.close();
  }
});
