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
    const result = await generateReview(token, 'review data', fetcher);
    expect(result.value).toEqual(review);
    expect(result.usage).toEqual({ input: 10, output: 20, total: 30 });
    expect(calls).toBe(1);
  });
  it('429でも再試行せず、外部エラー本文を漏らさない', async () => {
    let calls = 0;
    await expect(
      generateReview('test-token', 'data', async () => {
        calls++;
        return Response.json({ error: { message: 'SECRET error body' } }, { status: 429 });
      }),
    ).rejects.toThrow(/^レビュー生成に失敗しました（HTTP 429）。$/);
    expect(calls).toBe(1);
  });
  it.each(['incomplete', 'failed', 'cancelled'])('APIの%sを成功扱いしない', async (status) => {
    await expect(
      generateReview('test-token', 'data', async () => response(status)),
    ).rejects.toThrow('レビュー生成に失敗しました');
  });
  it.each(['', 'not-json', 'x'.repeat(30001)])('空・不正・過大出力を拒否する', async (text) => {
    await expect(
      generateReview('test-token', 'data', async () => response('completed', text)),
    ).rejects.toThrow('レビュー生成に失敗しました');
  });
  it('通信例外の内容を漏らさない', async () => {
    await expect(
      generateReview('test-token', 'data', async () => {
        throw new Error('SECRET');
      }),
    ).rejects.toThrow(/^レビュー生成に失敗しました。$/);
  });
});
