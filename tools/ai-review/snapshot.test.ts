import { expect, it } from 'vitest';
import { comments, reviewComments, type Api } from './github.ts';
import { normalizeSnapshot, snapshotRevision, loadSnapshot } from './snapshot.ts';
const user = { id: 1, login: 'human', type: 'User' };
const root = {
  id: 1,
  body: 'original',
  user,
  path: 'a.ts',
  line: 1,
  original_line: 1,
  commit_id: 'a'.repeat(40),
  original_commit_id: 'a'.repeat(40),
};
const input = {
  issues: [{ id: 3, body: 'human', user }],
  inline: [root, { ...root, id: 2, in_reply_to_id: 1, body: 'reply' }],
  threads: [{ id: 'T1', root: 1, resolved: false }],
};
it.each([1000, 1001])('通常・行コメント%s件を打ち切らない', async (count) => {
  const api: Api = async <T>(path: string) => {
    const page = Number(new URL('https://example.invalid/' + path).searchParams.get('page'));
    return Array.from({ length: Math.max(0, Math.min(100, count - (page - 1) * 100)) }, (_, i) => ({
      id: (page - 1) * 100 + i + 1,
    })) as T;
  };
  expect(await comments(api, 1)).toHaveLength(count);
  expect(await reviewComments(api, 1)).toHaveLength(count);
});
it('末尾API失敗は部分履歴にしない', async () => {
  const api: Api = async <T>(path: string) => {
    if (path.endsWith('page=12')) throw new Error('tail failed');
    return Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) as T;
  };
  await expect(comments(api, 1)).rejects.toThrow('tail failed');
});
it('取得順だけでは改訂にならない', () => {
  expect(snapshotRevision(normalizeSnapshot(input))).toBe(
    snapshotRevision(normalizeSnapshot({ ...input, inline: [...input.inline].reverse() })),
  );
});
it.each(['body', 'reply', 'resolved', 'deleted'])('変更%sを検出する', (kind) => {
  const changed = structuredClone(input);
  if (kind === 'body') changed.inline[0].body = 'edited';
  if (kind === 'reply') changed.inline[1].body = 'edited reply';
  if (kind === 'resolved') changed.threads[0].resolved = true;
  if (kind === 'deleted') changed.issues = [];
  expect(snapshotRevision(normalizeSnapshot(changed))).not.toBe(
    snapshotRevision(normalizeSnapshot(input)),
  );
});
it('21返信・16KiB本文・128KiB履歴を切り捨てない', () => {
  const inline = [
    root,
    ...Array.from({ length: 21 }, (_, i) => ({
      ...root,
      id: i + 2,
      in_reply_to_id: 1,
      body: 'x'.repeat(20000),
    })),
  ];
  const value = normalizeSnapshot({ ...input, inline });
  expect(value.inline).toHaveLength(22);
  expect(JSON.stringify(value).length).toBeGreaterThan(128 * 1024);
});
it('Resolve状態が取得できない時は停止する', async () => {
  const api: Api = async <T>(path: string) => {
    if (path === 'graphql') return { errors: [{ message: 'failed' }] } as T;
    return [] as T;
  };
  await expect(loadSnapshot(api, 1)).rejects.toThrow();
});
