import { expect, test } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { saveMaterialAnalysis, findMaterialTheme } from '../src/server/repositories/materials.ts';

test('検証済み候補を本人と期限に結び付け、Markdown全文を保存しない', async () => {
  const database = createTestDatabase();
  try {
    const theme = { title: '構成', heading: '判断', excerpt: '静的配信を選んだ。' };
    await saveMaterialAnalysis(database.db, {
      analysisId: 'analysis',
      actorId: 'actor',
      markdown: '# 判断\n静的配信を選んだ。\n未選択の秘密の原文',
      result: { themes: [theme] },
      model: 'test-model',
      promptVersion: 'v1',
      createdAt: 100,
      expiresAt: 200,
    });
    expect(await findMaterialTheme(database.db, 'actor', 'analysis', 0, 100)).toEqual({
      theme,
      materialHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await findMaterialTheme(database.db, 'other', 'analysis', 0, 100)).toBeNull();
    expect(await findMaterialTheme(database.db, 'actor', 'analysis', 0, 200)).toBeNull();
    expect(await findMaterialTheme(database.db, 'actor', 'analysis', 1, 100)).toBeNull();
    expect(await findMaterialTheme(database.db, 'actor', 'analysis', 0.5, 100)).toBeNull();
    expect(
      JSON.stringify(database.sqlite.prepare('SELECT * FROM material_analyses').all()),
    ).not.toContain('未選択の秘密の原文');
  } finally {
    database.close();
  }
});
