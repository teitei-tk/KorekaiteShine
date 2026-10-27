import { describe, expect, it } from 'vitest';
import { generateReview } from './review.ts';

const review = { status: 'complete', summary: '確認済み', uncertainties: [], findings: [] };
function response(status = 'completed', text = JSON.stringify(review)) {
  return Response.json({
    id: 'resp_test',
    object: 'response',
    status,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  });
}
describe('SDKレビュー', () => {
  it('長い短命トークンで固定APIを呼び、ツールなし・構造化出力・上限を指定する', async () => {
    const token = 'test-token-' + 'x'.repeat(2048);
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: 'gpt-6-luna',
        tools: [],
        store: false,
        max_output_tokens: 8000,
        reasoning: { effort: 'medium' },
        text: { format: { type: 'json_schema', strict: true } },
      });
      return response();
    };
    const result = await generateReview(token, 'review data', {}, fetcher);
    expect(result.value).toEqual(review);
    expect(result.usage).toEqual({ input: 10, output: 20, total: 30 });
    expect(calls).toBe(1);
  });
  it('429でも再試行せず、外部エラー本文を漏らさない', async () => {
    let calls = 0;
    await expect(
      generateReview('test-token', 'data', {}, async () => {
        calls++;
        return Response.json({ error: { message: 'SECRET error body' } }, { status: 429 });
      }),
    ).rejects.toThrow(/^レビュー生成に失敗しました（HTTP 429）。$/);
    expect(calls).toBe(1);
  });
  it.each(['incomplete', 'failed', 'cancelled'])('APIの%sを成功扱いしない', async (status) => {
    await expect(
      generateReview('test-token', 'data', {}, async () => response(status)),
    ).rejects.toThrow('レビュー生成に失敗しました');
  });
  it.each(['', 'not-json', 'x'.repeat(30001)])('空・不正・過大出力を拒否する', async (text) => {
    await expect(
      generateReview('test-token', 'data', {}, async () => response('completed', text)),
    ).rejects.toThrow('レビュー生成に失敗しました');
  });
  it('JSONとして正常でもレビュー形式が不正なら拒否する', async () => {
    await expect(
      generateReview('test-token', 'data', {}, async () =>
        response('completed', '{"status":"complete"}'),
      ),
    ).rejects.toMatchObject({
      reason: 'OUTPUT_INVALID',
      detail: { subcode: 'REVIEW_FORMAT_INVALID', missing: [] },
    });
  });
  it('差分にない行への指摘をSDK境界で拒否する', async () => {
    const invalid = {
      ...review,
      findings: [
        {
          priority: 'P1',
          path: 'app.ts',
          line: 10,
          condition: '条件',
          impact: '影響',
          fix: '修正',
        },
      ],
    };
    await expect(
      generateReview('test-token', 'data', { 'app.ts': [1] }, async () =>
        response('completed', JSON.stringify(invalid)),
      ),
    ).rejects.toMatchObject({
      reason: 'OUTPUT_INVALID',
      detail: { subcode: 'FINDING_LOCATION_INVALID', missing: [] },
    });
  });
  it('通信例外の内容を漏らさない', async () => {
    await expect(
      generateReview('test-token', 'data', {}, async () => {
        throw new Error('SECRET');
      }),
    ).rejects.toThrow(/^レビュー生成に失敗しました。$/);
  });
});
it('SDK応答検証で確定した安全な失敗コードを呼び出し元へ保持する', async () => {
  const { requestStructuredReview } = await import('./review.ts');
  const { ReviewFailure } = await import('./failure.ts');
  await expect(
    requestStructuredReview(
      'fixture-token',
      'data',
      () => {
        throw new ReviewFailure('MISSING_EVIDENCE', '根拠が不足しています');
      },
      async () => response(),
    ),
  ).rejects.toMatchObject({ reason: 'MISSING_EVIDENCE' });
});
it.each([
  ['incomplete', 'max_output_tokens', 'TOKEN_LIMIT'],
  ['incomplete', 'content_filter', 'CONTENT_FILTER'],
  ['failed', 'SECRET', 'API_INCOMPLETE'],
])('API中断を固定サブコードへ分類する: %s / %s', async (status, reason, subcode) => {
  await expect(
    generateReview('SECRET_TOKEN', 'SECRET_PROMPT', {}, async () =>
      Response.json({
        id: 'resp_test',
        object: 'response',
        status,
        incomplete_details: { reason },
        output: [],
      }),
    ),
  ).rejects.toMatchObject({ reason: 'INCOMPLETE', detail: { subcode, missing: [] } });
});
it.each([
  ['', 'EMPTY_OUTPUT'],
  ['not-json SECRET', 'INVALID_JSON'],
  ['x'.repeat(30001), 'INVALID_JSON'],
])('出力不正の詳細に生出力を含めない: %s', async (text, subcode) => {
  await expect(
    generateReview('SECRET_TOKEN', 'SECRET_PROMPT', {}, async () => response('completed', text)),
  ).rejects.toMatchObject({ detail: { subcode, missing: [] } });
});
