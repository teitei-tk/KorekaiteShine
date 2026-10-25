import { expect, it } from 'vitest';
import { target } from './github.ts';
import type { Api } from './github.ts';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
function setup(kind = 'owner') {
  const requests: string[] = [];
  const pr = {
    number: 7,
    user: { id: kind === 'other' ? 1 : 1324680, type: 'User' },
    state: 'open',
    draft: false,
    head: { sha: head, repo: { id: 1426899426 } },
    base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
  };
  const run = {
    event: 'pull_request',
    conclusion: 'success',
    path: '.github/workflows/docs.yml',
    head_sha: kind === 'stale' ? 'c'.repeat(40) : head,
    repository: { id: 1426899426 },
    head_repository: { id: kind === 'fork' ? 1 : 1426899426 },
    pull_requests: [
      {
        number: 7,
        head: { sha: head },
        base: { sha: kind === 'stale-base' ? 'e'.repeat(40) : base },
      },
    ],
  };
  const api: Api = async <T>(path: string) => {
    requests.push(path);
    if (path.startsWith('actions/')) return run as T;
    if (path === 'pulls/7') return pr as T;
    if (path.startsWith('git/commits/'))
      return { parents: [{ sha: base }, { sha: 'd'.repeat(40) }] } as T;
    if (path.startsWith('issues/')) return [] as T;
    throw new Error('予期しない呼び出し');
  };
  return { api, requests };
}
it('他人のPRは再実行者に関係なく除外し資料取得へ進まない', async () => {
  const { api, requests } = setup('other');
  expect(await target(api, 1)).toBeNull();
  expect(requests).toEqual(['actions/runs/1', 'pulls/7']);
});
it('forkはPR取得前に拒否する', async () => {
  const { api, requests } = setup('fork');
  expect(await target(api, 1)).toBeNull();
  expect(requests).toEqual(['actions/runs/1']);
});
it('CI後にheadが変わっていたら実行しない', async () =>
  expect(await target(setup('stale').api, 1)).toBeNull());
it('本人の最新headを返す', async () => expect((await target(setup().api, 1))?.number).toBe(7));
it('API取得失敗を許可として扱わない', async () => {
  const api: Api = async () => {
    throw new Error('API failed');
  };
  await expect(target(api, 1)).rejects.toThrow();
});

it('CI後にbaseだけ進んだ場合も認証前に拒否する', async () =>
  expect(await target(setup('stale-base').api, 1)).toBeNull());

it('コメント100件のページで打ち切らず、次ページの指摘も取得する', async () => {
  const { comments } = await import('./github.ts');
  const first = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    body: '履歴',
    user: { login: 'someone', type: 'User' },
  }));
  const last = { id: 101, body: '過去の指摘', user: { login: 'github-actions[bot]', type: 'Bot' } };
  const paths: string[] = [];
  const api: Api = async <T>(path: string) => {
    paths.push(path);
    return (path.endsWith('page=1') ? first : [last]) as T;
  };
  expect(await comments(api, 11)).toEqual([...first, last]);
  expect(paths).toEqual([
    'issues/11/comments?per_page=100&page=1',
    'issues/11/comments?per_page=100&page=2',
  ]);
});
