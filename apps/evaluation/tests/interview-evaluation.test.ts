import { createInterviewEvaluator } from '../src/server/openai-interview-evaluator.ts';
import { expect, test, vi } from 'vitest';
import type { EvaluationSnapshot } from '@korekaite/database';
import { evaluateInterview } from '../src/application/evaluate-interview.ts';

export const snapshot: EvaluationSnapshot = {
  schemaVersion: 1,
  interview: {
    interviewId: 'interview',
    materialHash: 'hash',
    themeTitle: '構成',
    themeHeading: '判断',
    themeExcerpt: '架空の経験',
    background: '',
    activeMs: 1000,
  },
  fragments: [
    {
      fragmentId: 'f1',
      interviewId: 'interview',
      sequence: 1,
      generation: 1,
      sourceEventId: 'e1',
      speaker: 'user',
      content: '制約を比較しました。',
      sourceStartMs: 0,
      sourceEndMs: 1000,
      receivedAt: 10,
    },
  ],
  playback: [],
  transcriptIncomplete: false,
  evaluation: {
    model: 'test-model',
    promptVersion: 'v1',
    rubricVersion: 'v1',
    instructions: '根拠だけで評価する。',
    rubric: '架空の評価基準',
  },
};
export function result() {
  const axis = { status: 'unconfirmed', score: null, reason: '未質問です。', evidence: [] };
  return {
    summary: '制約について説明した。',
    axes: {
      problem: {
        status: 'scored',
        score: 2,
        reason: '比較内容の説明が不足している。',
        evidence: [{ source: 'transcript', fragmentIds: ['f1'], quote: '制約を比較しました。' }],
      },
      alternatives: axis,
      reasoning: axis,
      action: axis,
      learning: axis,
    },
    strengths: [],
    gaps: [],
    unconfirmed: [],
    practiceQuestions: [],
    consistency: [],
  };
}

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
  let sent = '';
  const generate = createInterviewEvaluator({
    apiKey: 'fixture-key',
    fetcher: async (_url, init) => {
      sent = String(init?.body);
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
  expect(JSON.parse(sent)).toMatchObject({
    model: 'test-model',
    store: false,
    tools: [],
    tool_choice: 'none',
    instructions: snapshot.evaluation.instructions,
  });
  expect(sent).toContain('制約を比較しました。');
  expect(sent).not.toContain('fixture-key');
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
