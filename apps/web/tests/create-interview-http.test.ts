import { expect, test } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { saveMaterialAnalysis } from '../src/server/repositories/materials.ts';
import { createInterviewRequest } from '../src/server/create-interview.ts';

const input = {
  interviewId: 'interview-1',
  analysisId: 'analysis-1',
  themeIndex: 0,
  background: '担当者として比較した。',
};
const request = (body = input) =>
  new Request('http://127.0.0.1/api/interviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('未認可・他人の候補・不正な本文を拒否し、面接を保存しない', async () => {
  const database = createTestDatabase();
  try {
    await saveMaterialAnalysis(database.db, {
      analysisId: 'analysis-1',
      actorId: 'other',
      markdown: '# 判断\n架空の経験',
      result: { themes: [{ title: '構成', heading: '判断', excerpt: '架空の経験' }] },
      model: 'test-model',
      promptVersion: 'v1',
      createdAt: 0,
      expiresAt: 200,
    });
    for (const [actor, type, body, status, code] of [
      [null, 'application/json', JSON.stringify(input), 403, 'FORBIDDEN'],
      ['actor', 'application/json', JSON.stringify(input), 404, 'ANALYSIS_NOT_FOUND'],
      ['actor', 'text/plain', JSON.stringify(input), 415, 'UNSUPPORTED_MEDIA_TYPE'],
      ['actor', 'application/json', '{broken', 400, 'INVALID_REQUEST'],
      [
        'actor',
        'application/json',
        JSON.stringify({ ...input, excerpt: '偽の抜粋' }),
        400,
        'INVALID_REQUEST',
      ],
      ['actor', 'application/json', ' '.repeat(30001), 413, 'REQUEST_TOO_LARGE'],
    ] as const) {
      const response = await createInterviewRequest(
        new Request('http://127.0.0.1/api/interviews', {
          method: 'POST',
          headers: { 'Content-Type': type, 'Content-Length': '1' },
          body,
        }),
        { db: database.db, actor: () => actor, now: () => 100 },
      );
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM interviews').get()).toEqual({
      count: 0,
    });
  } finally {
    database.close();
  }
});

test('保存済みテーマで面接を開始し、分析候補の期限後も同じ開始要求を再送できる', async () => {
  const database = createTestDatabase();
  try {
    await saveMaterialAnalysis(database.db, {
      analysisId: 'analysis-1',
      actorId: 'actor',
      markdown: '# 判断\n静的配信を選んだ。',
      result: { themes: [{ title: '配信方式', heading: '判断', excerpt: '静的配信を選んだ。' }] },
      model: 'test-model',
      promptVersion: 'v1',
      createdAt: 100,
      expiresAt: 200,
    });
    const deps = { db: database.db, actor: () => 'actor', now: () => 100 };
    const first = await createInterviewRequest(request(), deps);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const accepted = await first.json();
    expect(accepted).toEqual({
      interviewId: 'interview-1',
      status: 'ready',
      theme: '配信方式',
      createdAt: 100,
      activeMs: 0,
    });
    const replay = await createInterviewRequest(request(), { ...deps, now: () => 201 });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(accepted);
    const changed = await createInterviewRequest(
      request({ ...input, background: '改変した補足' }),
      deps,
    );
    expect(changed.status).toBe(409);
    const competing = await createInterviewRequest(
      request({ ...input, interviewId: 'other-interview' }),
      deps,
    );
    expect(competing.status).toBe(409);
    const row = database.sqlite.prepare('SELECT theme_excerpt, background FROM interviews').get();
    database.sqlite.exec('UPDATE interviews SET created_at=-1');
    expect((await createInterviewRequest(request(), deps)).status).toBe(503);
    database.sqlite.exec('DROP TABLE interviews');
    expect((await createInterviewRequest(request(), deps)).status).toBe(503);
    expect(row).toEqual({ theme_excerpt: '静的配信を選んだ。', background: input.background });
  } finally {
    database.close();
  }
});
