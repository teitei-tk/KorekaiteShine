import { expect, test } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { createInterview } from '../src/server/repositories/interviews.ts';

test('開始の同時要求を一件だけ受け付け、同じ要求の再送は同じ面接を返す', async () => {
  const database = createTestDatabase();
  try {
    const input = {
      actorId: 'actor',
      materialHash: 'hash',
      themeTitle: '構成の判断',
      themeHeading: '背景',
      themeExcerpt: '架空の経験',
      background: '',
    };
    const results = await Promise.all([
      createInterview(database.db, { ...input, interviewId: 'first' }, 0),
      createInterview(database.db, { ...input, interviewId: 'second' }, 0),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    const accepted = results.find((result) => result !== null)!;
    expect(
      await createInterview(database.db, { ...input, interviewId: accepted.interviewId }, 1),
    ).toEqual(accepted);
    expect(
      await createInterview(
        database.db,
        {
          ...input,
          interviewId: accepted.interviewId,
          actorId: 'other',
        },
        1,
      ),
    ).toBeNull();
    expect(
      await createInterview(
        database.db,
        {
          ...input,
          interviewId: accepted.interviewId,
          themeExcerpt: '変更された材料',
        },
        1,
      ),
    ).toBeNull();
  } finally {
    database.close();
  }
});
