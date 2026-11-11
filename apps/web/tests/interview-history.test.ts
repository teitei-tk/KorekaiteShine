import { expect, test } from 'vitest';
import { interviews } from '@korekaite/database/interviews';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { interviewHistoryRequest } from '../src/server/interview-history';

test('本人の履歴だけを新しい順に返し、同時刻の面接もカーソルで重複なく取得する', async () => {
  const database = createTestDatabase();
  try {
    for (const index of Array(23).keys()) {
      await database.db.insert(interviews).values({
        interviewId: `id-${String(index).padStart(2, '0')}`,
        actorId: index === 22 ? 'other' : 'actor',
        materialHash: 'hash',
        themeTitle: '架空の判断',
        themeHeading: '背景',
        themeExcerpt: '架空の経験',
        background: '',
        status: 'ended',
        createdAt: 100,
        updatedAt: 100,
        endedAt: 100,
      });
    }
    const deps = { db: database.db, actor: () => 'actor' };
    const first = await interviewHistoryRequest(
      new Request('http://localhost/api/interview-history'),
      deps,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const page = await first.json();
    expect(page.items).toHaveLength(20);
    expect(page.items[0]).toEqual({
      interviewId: 'id-21',
      status: 'ended',
      theme: '架空の判断',
      createdAt: 100,
      activeMs: 0,
    });
    expect(page.next).toEqual({ createdAt: 100, interviewId: 'id-02' });
    const second = await interviewHistoryRequest(
      new Request('http://localhost/api/interview-history?beforeCreatedAt=100&beforeId=id-02'),
      deps,
    );
    expect(await second.json()).toMatchObject({
      items: [{ interviewId: 'id-01' }, { interviewId: 'id-00' }],
      next: null,
    });
    for (const query of [
      'beforeId=id-02',
      'beforeCreatedAt=100',
      'beforeCreatedAt=1&beforeCreatedAt=2&beforeId=x',
      'extra=1',
      '__proto__=x',
      'beforeCreatedAt=NaN&beforeId=x',
      'beforeCreatedAt=-1&beforeId=x',
    ]) {
      const response = await interviewHistoryRequest(
        new Request(`http://localhost/api/interview-history?${query}`),
        deps,
      );
      expect(response.status).toBe(400);
    }
    expect(
      (
        await interviewHistoryRequest(new Request('http://localhost/api/interview-history'), {
          ...deps,
          actor: () => null,
        })
      ).status,
    ).toBe(403);
    const request = new Request('http://localhost/api/interview-history');
    database.sqlite.exec('UPDATE interviews SET created_at=-1');
    expect((await interviewHistoryRequest(request, deps)).status).toBe(503);
    database.sqlite.exec('DROP TABLE interviews');
    expect((await interviewHistoryRequest(request, deps)).status).toBe(503);
  } finally {
    database.close();
  }
});
