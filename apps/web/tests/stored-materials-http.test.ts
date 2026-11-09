import { expect, test, vi } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { analyzeStoredMaterialRequest } from '../src/server/stored-materials';
import { materialAnalyses } from '@korekaite/database/materials';
import { usageReservations } from '@korekaite/database/usage';

test('分析枠を確保してからAIへ送り、保存した候補を返し、上限ではAIを呼ばない', async () => {
  const database = createTestDatabase();
  let sequence = 0;
  const analyze = vi.fn(async () => ({
    themes: [{ title: '判断', heading: '本文', excerpt: '架空の経験' }],
  }));
  const request = () =>
    new Request('http://localhost/api/materials/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true, markdown: '架空の経験' }),
    });
  const deps = {
    db: database.db,
    actor: () => 'actor',
    now: () => 1000,
    newId: () => `analysis-${++sequence}`,
    apiKey: 'fixture',
    model: 'mock',
    analyze,
  };
  try {
    expect(
      (await analyzeStoredMaterialRequest(request(), { ...deps, actor: () => null })).status,
    ).toBe(403);
    expect((await analyzeStoredMaterialRequest(request(), { ...deps, apiKey: '' })).status).toBe(
      503,
    );
    expect(
      (await analyzeStoredMaterialRequest(request(), { ...deps, actor: () => '' })).status,
    ).toBe(503);
    expect(await database.db.select().from(usageReservations)).toHaveLength(0);
    for (let index = 0; index < 10; index += 1) {
      const response = await analyzeStoredMaterialRequest(request(), deps);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        themes: [{ excerpt: '架空の経験' }],
        analysisId: expect.any(String),
      });
    }
    expect((await analyzeStoredMaterialRequest(request(), deps)).status).toBe(429);
    expect(analyze).toHaveBeenCalledTimes(10);
    expect(await database.db.select().from(materialAnalyses)).toHaveLength(10);
    expect(await database.db.select().from(usageReservations)).toHaveLength(10);
  } finally {
    database.close();
  }
});
