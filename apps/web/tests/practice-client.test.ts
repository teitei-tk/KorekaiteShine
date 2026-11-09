import { afterEach, expect, test, vi } from 'vitest';
import {
  analyzeMarkdown,
  prepareInterview,
  readDetail,
  readHistory,
  sessionToken,
  requestEvaluationRetry,
  deleteSavedInterview,
} from '../src/lib/practice';

const signal = new AbortController().signal;
const input = { interviewId: 'one', analysisId: 'analysis', themeIndex: 0, background: '' };
function respond(result: object, status = 200) {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ operationToken: 'a'.repeat(64) }))
    .mockResolvedValueOnce(Response.json(result, { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

test.each([403, 200])('トークンが取得できない応答 %i を拒否する', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status })));
  await expect(sessionToken(signal)).rejects.toThrow('ローカル接続');
});

test.each([
  ['分析', () => analyzeMarkdown('材料'), '分析結果'],
  ['準備', () => prepareInterview(input), '準備結果'],
  ['履歴', () => readHistory(null, signal), '履歴'],
  ['詳細', () => readDetail('one', signal), '記録'],
  ['再評価', () => requestEvaluationRetry('one', 'failed'), '再評価'],
  ['削除', () => deleteSavedInterview('one'), '削除'],
] as const)('%sの成功応答を検証する', async (_name, call, message) => {
  respond({});
  await expect(call()).rejects.toThrow(message);
});

test.each(['INVALID_MATERIAL', 'INTERVIEW_CONFLICT', 'NOT_FOUND', 'UNKNOWN'])(
  'POST失敗で契約に合うエラーメッセージを表示する (%s)',
  async (code) => {
    respond({ error: { code, message: '要求に失敗しました' } }, 400);
    await expect(analyzeMarkdown('経験')).rejects.toThrow(
      code === 'UNKNOWN' ? 'もう一度' : '要求に失敗',
    );
  },
);

test.each(['NOT_FOUND', 'UNKNOWN'])('記録取得の失敗 %s を表示する', async (code) => {
  respond({ error: { code, message: '見つかりません' } }, 404);
  await expect(readDetail('one', signal)).rejects.toThrow(
    code === 'UNKNOWN' ? '取得できません' : '見つかりません',
  );
});

test('ページのカーソルと再評価の対象IDを送る', async () => {
  const history = respond({ items: [], next: null });
  await expect(readHistory({ createdAt: 2, interviewId: 'one' }, signal)).resolves.toMatchObject({
    items: [],
  });
  expect(history.mock.lastCall?.[0]).toBe('/api/interview-history?beforeCreatedAt=2&beforeId=one');
  const retry = respond({ jobId: '00000000-0000-4000-8000-000000000001' });
  await expect(requestEvaluationRetry('a/b', 'failed')).resolves.toEqual({
    jobId: '00000000-0000-4000-8000-000000000001',
  });
  expect(retry.mock.lastCall).toEqual([
    '/api/interviews/a%2Fb/retry',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ failedJobId: 'failed' }),
    }),
  ]);
});
