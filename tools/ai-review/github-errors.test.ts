import { afterEach, expect, it, vi } from 'vitest';
import { comments, githubApi, target, type Api } from './github.ts';

afterEach(() => vi.unstubAllGlobals());

it('不正な実行IDはGitHubへ照会する前に拒否する', async () => {
  const requested = vi.fn();
  const api: Api = async () => {
    requested();
    throw new Error('想定外のAPI要求');
  };
  await expect(target(api, 0)).rejects.toThrow('実行IDが不正');
  expect(requested).not.toHaveBeenCalled();
});

it('コメント一覧が配列でなければ未投稿と見なさず失敗する', async () => {
  const api: Api = async <T>() => ({ message: 'private response' }) as T;
  await expect(comments(api, 7)).rejects.toThrow('コメント応答が不正');
});

it('GitHub HTTPエラーに応答本文やトークンを含めない', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('private response', { status: 403 })),
  );
  await expect(githubApi('private-token')('issues/1')).rejects.toThrow(/^GitHub API HTTP 403$/);
});

it('GitHub GraphQLの要求本文をJSONとして送る', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: {} }));
  vi.stubGlobal('fetch', fetcher);
  const body = { query: 'query { viewer { login } }', variables: { number: 1, cursor: null } };
  await githubApi('fixture-token')('graphql', 'POST', body);
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.github.com/graphql',
    expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
  );
});

it('GitHub RESTの既定GETは本文なしで固定リポジトリへ要求する', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ value: 1 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(githubApi('fixture-token')('issues/1')).resolves.toEqual({ value: 1 });
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.github.com/repos/teitei-tk/KorekaiteShine/issues/1',
    expect.objectContaining({ method: 'GET', redirect: 'error' }),
  );
  expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
});

it('GitHub認証が空ならHTTP要求を開始しない', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(() => githubApi('')).toThrow('GitHub認証がありません');
  expect(fetcher).not.toHaveBeenCalled();
});
