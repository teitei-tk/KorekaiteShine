import { expect, test, vi } from 'vitest';
import { analyzeMaterialRequest } from '../src/server/materials';

test('分析結果の永続化を待って保存IDを返し、保存失敗を成功にしない', async () => {
  const input = { markdown: '# 判断\n静的配信を選んだ。', confirmed: true };
  const result = { themes: [{ title: '構成', heading: '判断', excerpt: '静的配信を選んだ。' }] };
  for (const succeeds of [true, false]) {
    const saveAnalysis = vi.fn(async () => {
      if (!succeeds) {
        throw new Error('DB内部エラーと秘密情報');
      }
      return 'analysis-1';
    });
    const response = await analyzeMaterialRequest(
      new Request('http://127.0.0.1/api/materials/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
      {
        authorize: () => true,
        reserveAnalysis: async () => true,
        analyze: async () => result,
        saveAnalysis,
      },
    );
    expect(saveAnalysis).toHaveBeenCalledWith(input.markdown, result);
    expect(response.status).toBe(succeeds ? 200 : 503);
    expect(await response.json()).toEqual(
      succeeds
        ? { ...result, analysisId: 'analysis-1' }
        : {
            error: {
              code: 'ANALYSIS_SAVE_FAILED',
              message: '分析結果を保存できませんでした。再度お試しください。',
            },
          },
    );
  }
});

test('材料分析HTTPは認可・送信確認・容量・利用枠を通過した要求だけを処理する', async () => {
  const theme = { title: '配信方式', heading: '判断', excerpt: '静的配信を選んだ。' };
  const input = { markdown: '# 判断\n静的配信を選んだ。', confirmed: true };
  for (const [authorized, type, body, allowed, status, code] of [
    [false, 'application/json', JSON.stringify(input), true, 403, 'FORBIDDEN'],
    [true, 'text/plain', JSON.stringify(input), true, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [true, 'application/json', '{broken', true, 400, 'INVALID_MATERIAL'],
    [
      true,
      'application/json',
      JSON.stringify({ ...input, confirmed: false }),
      true,
      400,
      'INVALID_MATERIAL',
    ],
    [
      true,
      'application/json',
      JSON.stringify({ ...input, markdown: 'あ'.repeat(10923) }),
      true,
      413,
      'MATERIAL_TOO_LARGE',
    ],
    [true, 'application/json', JSON.stringify(input), false, 429, 'USAGE_LIMIT'],
    [true, 'application/json; charset=utf-8', JSON.stringify(input), true, 200, null],
  ] as const) {
    const analyze = vi.fn(async () => ({ themes: [theme] }));
    const reserveAnalysis = vi.fn(async () => allowed);
    const saveAnalysis = vi.fn(async () => 'analysis-1');
    const response = await analyzeMaterialRequest(
      new Request('http://127.0.0.1/api/materials/analyze', {
        method: 'POST',
        headers: { 'Content-Type': type },
        body,
      }),
      { authorize: () => authorized, reserveAnalysis, analyze, saveAnalysis },
    );
    expect(response.status).toBe(status);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    if (status === 200) {
      expect(await response.json()).toEqual({ themes: [theme], analysisId: 'analysis-1' });
      expect(analyze).toHaveBeenCalledTimes(1);
    } else {
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(analyze).not.toHaveBeenCalled();
    }
    expect(saveAnalysis).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    expect(reserveAnalysis).toHaveBeenCalledTimes(status === 200 || status === 429 ? 1 : 0);
  }
});

test('本文サイズを申告ヘッダーに依存せず制限し、超過ストリームを中止する', async () => {
  const cancel = vi.fn();
  const encoder = new TextEncoder();
  const sentState = { sent: false };
  const body = new ReadableStream({
    pull(controller) {
      if (!sentState.sent) {
        sentState.sent = true;
        controller.enqueue(encoder.encode(' '.repeat(200_001)));
      } else {
        controller.enqueue(encoder.encode('{"markdown":"資料","confirmed":true}'));
        controller.close();
      }
    },
    cancel,
  });
  const request = new Request('http://127.0.0.1/api/materials/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '1' },
    body,
    duplex: 'half',
  } as RequestInit);
  const analyze = vi.fn(async () => ({ themes: [] }));
  const reserveAnalysis = vi.fn(async () => true);
  const response = await analyzeMaterialRequest(request, {
    authorize: () => true,
    saveAnalysis: async () => 'unused',
    reserveAnalysis,
    analyze,
  });
  expect(response.status).toBe(413);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(reserveAnalysis).not.toHaveBeenCalled();
  expect(analyze).not.toHaveBeenCalled();
});

test('空の本文、根拠のないAI結果、不正な保存IDを異なるエラーで返す', async () => {
  const markdown = 'テスト材料';
  const deps = {
    authorize: () => true,
    reserveAnalysis: async () => true,
    saveAnalysis: async () => '',
    analyze: async () => ({ themes: [{ title: '選択', heading: '本文', excerpt: markdown }] }),
  };
  const post = (body?: string) =>
    new Request('http://localhost/api/materials/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  const body = JSON.stringify({ markdown, confirmed: true });
  expect(await (await analyzeMaterialRequest(post(), deps)).json()).toMatchObject({
    error: { code: 'INVALID_MATERIAL' },
  });
  expect(
    await (await analyzeMaterialRequest(post(body), { ...deps, analyze: async () => null })).json(),
  ).toMatchObject({ error: { code: 'INVALID_AI_RESULT' } });
  expect(await (await analyzeMaterialRequest(post(body), deps)).json()).toMatchObject({
    error: { code: 'ANALYSIS_SAVE_FAILED' },
  });
});
