import { expect, test } from 'vitest';
import { getInterviews } from '../src/lib/interviews';
import { listInterviews } from '../src/server/interviews';

test('生成型を使うクライアントで面接一覧を取得できる', async () => {
  const fetcher: typeof fetch = async (input, init) => listInterviews(new Request(input, init));
  const result = await getInterviews('http://localhost', fetcher);
  expect(result.items.map((item) => item.id)).toEqual(['interview-002', 'interview-001']);
});

test('型定義だけを信用せず、契約に違反するAPI応答を拒否する', async () => {
  const fetcher: typeof fetch = async () => Response.json({ items: [{ id: 'invalid' }] });
  await expect(getInterviews('http://localhost', fetcher)).rejects.toThrow(
    '面接一覧の形式が契約と一致しません。',
  );
});
