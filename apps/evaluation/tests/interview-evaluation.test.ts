import { createInterviewEvaluator } from '../src/server/openai-interview-evaluator.ts';
import { expect, test, vi } from 'vitest';
import { result, snapshot } from './fixtures/evaluation';
import { evaluateInterview } from '../src/application/evaluate-interview.ts';

test('保存された原文に基づく五軸評価を返し、捏造引用と状態・点数の不整合を拒否する', async () => {
  const signal = new AbortController().signal;
  const good = result();
  expect(await evaluateInterview(snapshot, signal, async () => good)).toMatchObject({
    ok: true,
    value: good,
  });
  const fabricated = result();
  fabricated.axes.problem.evidence[0].quote = '成果を10倍にしました。';
  expect(await evaluateInterview(snapshot, signal, async () => fabricated)).toMatchObject({
    ok: false,
    error: { code: 'INVALID_AI_RESULT' },
  });
  const mismatched = result();
  mismatched.axes.problem.status = 'unconfirmed';
  expect(await evaluateInterview(snapshot, signal, async () => mismatched)).toMatchObject({
    ok: false,
  });
  expect(
    await evaluateInterview(
      {
        ...snapshot,
        fragments: [
          { ...snapshot.fragments[0], speaker: 'assistant' },
          { ...snapshot.fragments[0], fragmentId: 'f2', sequence: 2 },
        ],
      },
      signal,
      async () => good,
    ),
  ).toMatchObject({ ok: false });
});

test('固定入力と採点基準をstore:falseで送り、秘密値や外部エラー本文を結果に残さない', async () => {
  const sentState = { sent: '' };
  const generate = createInterviewEvaluator({
    apiKey: 'fixture-key',
    fetcher: async (_url, init) => {
      sentState.sent = String(init?.body);
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: JSON.stringify(result()) }],
          },
        ],
      });
    },
  });
  expect(await evaluateInterview(snapshot, new AbortController().signal, generate)).toMatchObject({
    ok: true,
  });
  expect(JSON.parse(sentState.sent)).toMatchObject({
    model: 'test-model',
    store: false,
    tools: [],
    tool_choice: 'none',
    instructions: snapshot.evaluation.instructions,
  });
  expect(sentState.sent).toContain('制約を比較しました。');
  expect(sentState.sent).not.toContain('fixture-key');
  const failed = createInterviewEvaluator({
    apiKey: 'fixture-key',
    fetcher: async () => new Response('fixture-key external-error', { status: 401 }),
  });
  const failure = await evaluateInterview(snapshot, new AbortController().signal, failed);
  expect(failure).toEqual({ ok: false, error: { code: 'AI_REQUEST_REJECTED', retryable: false } });
  const limited = createInterviewEvaluator({
    apiKey: 'fixture-key',
    fetcher: async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
  });
  expect(await evaluateInterview(snapshot, new AbortController().signal, limited)).toEqual({
    ok: false,
    error: { code: 'AI_RATE_LIMITED', retryable: true, retryAfterMs: 120000 },
  });
});

test('日付形式のRetry-Afterも尊重し、不明な指定で早期再試行しない', async () => {
  const fetcher = async () =>
    new Response('', { status: 429, headers: { 'Retry-After': 'Fri, 06 Nov 2026 00:02:00 GMT' } });
  const generate = createInterviewEvaluator({
    apiKey: 'fixture-key',
    fetcher,
    now: () => 1793923200000,
  });
  expect(await evaluateInterview(snapshot, new AbortController().signal, generate)).toEqual({
    ok: false,
    error: { code: 'AI_RATE_LIMITED', retryable: true, retryAfterMs: 120000 },
  });
  const invalid = createInterviewEvaluator({
    apiKey: 'fixture-key',
    fetcher: async () =>
      new Response('', { status: 429, headers: { 'Retry-After': 'unexpected' } }),
  });
  expect(await evaluateInterview(snapshot, new AbortController().signal, invalid)).toMatchObject({
    ok: false,
    error: { code: 'AI_RETRY_AFTER_INVALID', retryable: false },
  });
});

test('利用者の回答がない場合はAIを呼ばず、点数なしの五軸結果を保存対象にする', async () => {
  const generate = vi.fn(async () => result());
  for (const fragments of [
    [],
    [{ ...snapshot.fragments[0], speaker: 'assistant' as const }],
    [{ ...snapshot.fragments[0], content: ' \n\t　' }],
  ]) {
    const evaluated = await evaluateInterview(
      { ...snapshot, fragments },
      new AbortController().signal,
      generate,
    );
    expect(evaluated).toMatchObject({ ok: true, value: { summary: '評価対象の回答なし' } });
    if (!evaluated.ok || !('axes' in evaluated.value)) {
      throw new Error('五軸結果がありません。');
    }
    expect(Object.values(evaluated.value.axes)).toHaveLength(5);
    for (const axis of Object.values(evaluated.value.axes)) {
      expect(axis).toMatchObject({ status: 'unconfirmed', score: null, evidence: [] });
    }
  }
  expect(generate).not.toHaveBeenCalled();
});

test('外部応答の形式・件数・役割・本文を確認してから評価を受け取る', async () => {
  const message = {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: '{}' }],
  };
  const responses = [
    null,
    [],
    'invalid',
    {},
    { status: 'completed', error: { message: 'failure' } },
    { status: 'completed', output: null },
    ...[
      [null, 1, { type: 'reasoning' }],
      [message, message],
      [{ ...message, role: 'user' }],
      [{ ...message, status: 'incomplete' }],
      [{ ...message, content: null }],
      [{ ...message, content: [] }],
      ...[
        null,
        [],
        1,
        { type: 'refusal' },
        { type: 'output_text' },
        { type: 'output_text', text: 'invalid json' },
      ].map((content) => [{ ...message, content: [content] }]),
    ].map((output) => ({ status: 'completed', output })),
  ];
  for (const response of responses) {
    const generate = createInterviewEvaluator({
      apiKey: 'fixture',
      fetcher: async () => Response.json(response),
    });
    expect(await evaluateInterview(snapshot, new AbortController().signal, generate)).toEqual({
      ok: false,
      error: { code: 'INVALID_AI_RESULT', retryable: true },
    });
  }
});

test('無効なAPI設定では送信を止め、HTTPエラーから再試行の可否を判定する', async () => {
  const signal = new AbortController().signal;
  for (const [apiKey, model] of [
    [' ', 'model'],
    ['fixture', ' '],
  ]) {
    const generate = createInterviewEvaluator({ apiKey });
    expect(
      await evaluateInterview(
        { ...snapshot, evaluation: { ...snapshot.evaluation, model } },
        signal,
        generate,
      ),
    ).toEqual({
      ok: false,
      error: { code: 'AI_CONFIGURATION_INVALID', retryable: false },
    });
  }
  for (const status of [408, 503]) {
    const generate = createInterviewEvaluator({
      apiKey: 'fixture',
      fetcher: async () => new Response(null, { status }),
    });
    expect(await evaluateInterview(snapshot, signal, generate)).toEqual({
      ok: false,
      error: { code: 'AI_UNAVAILABLE', retryable: true },
    });
  }
  for (const value of ['Sat, 31 Feb 2024 00:00:00 GMT', '999999999999999999']) {
    const generate = createInterviewEvaluator({
      apiKey: 'fixture',
      fetcher: async () => new Response(null, { status: 429, headers: { 'Retry-After': value } }),
    });
    expect(await evaluateInterview(snapshot, signal, generate)).toEqual({
      ok: false,
      error: { code: 'AI_RETRY_AFTER_INVALID', retryable: false },
    });
  }
});

test('評価開始前と実行中の中断を検知する', async () => {
  const generate = vi.fn(async () => result());
  expect(await evaluateInterview(snapshot, AbortSignal.abort(), generate)).toMatchObject({
    error: { code: 'AI_ABORTED' },
  });
  expect(generate).not.toHaveBeenCalled();
  const controller = new AbortController();
  expect(
    await evaluateInterview(snapshot, controller.signal, async () => {
      controller.abort();
      return result();
    }),
  ).toMatchObject({ error: { code: 'INVALID_AI_RESULT' } });
});

test('材料の引用、連続した発言、整合性評価の二つの根拠を保存内容と照合する', async () => {
  const base = snapshot.fragments[0];
  const input = {
    ...snapshot,
    fragments: [
      base,
      { ...base, fragmentId: 'f2', sequence: 2, content: '次の回答' },
      { ...base, fragmentId: 'f4', sequence: 4 },
      { ...base, fragmentId: 'f5', sequence: 5, speaker: 'assistant' as const },
    ],
  };
  const transcript = (ids: string[], quote = base.content) => ({
    source: 'transcript',
    fragmentIds: ids,
    quote,
  });
  const material = { source: 'material', fragmentIds: [], quote: input.interview.themeExcerpt };
  const evaluate = async (overrides: object) =>
    (
      await evaluateInterview(input, new AbortController().signal, async () => ({
        ...result(),
        ...overrides,
      }))
    ).ok;
  for (const [evidence, expected] of [
    [material, true],
    [{ ...material, fragmentIds: ['f1'] }, false],
    [{ ...material, quote: '不一致' }, false],
    [transcript([]), false],
    [transcript(['missing']), false],
    [transcript(['f1', 'f4']), false],
    [transcript(['f4', 'f5']), false],
    [transcript(['f1', 'f2'], base.content + '次の回答'), true],
  ] as const) {
    expect(await evaluate({ strengths: [{ text: '観察', evidence: [evidence] }] })).toBe(expected);
  }
  const first = transcript(['f1']),
    second = transcript(['f2'], '次の回答');
  for (const [left, right, expected] of [
    [first, second, true],
    [first, first, false],
    [material, second, false],
    [first, material, false],
    [transcript([]), second, false],
    [first, transcript([]), false],
  ] as const) {
    expect(
      await evaluate({
        consistency: [{ first: left, second: right, status: 'resolved', explanation: '説明' }],
      }),
    ).toBe(expected);
  }
});
