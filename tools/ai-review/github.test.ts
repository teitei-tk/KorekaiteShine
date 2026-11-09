import { expect, it } from 'vitest';
import { target } from './github.ts';
import type { Api } from './github.ts';
import { MARKER, revisionMarker } from './policy.ts';

it('同じbaseとheadの完了マーカーがあれば再レビューしない', async () => {
  const fixture = setup();
  fixture.prior.push({
    id: 1,
    body: MARKER + revisionMarker(head, base),
    user: { login: 'github-actions[bot]', type: 'Bot' },
  });
  expect(await target(fixture.api, 1)).toMatchObject({ status: 'already-complete' });
});

it('CIのheadが不正なSHAならmergeの照会へ進まない', async () => {
  const fixture = setup();
  fixture.run.head_sha = 'invalid';
  expect(await target(fixture.api, 1)).toEqual({ status: 'excluded' });
  expect(fixture.requests).toEqual(['actions/runs/1', 'pulls/7']);
});

it('取得したPRの番号がCIの対象と違う場合は除外する', async () => {
  const fixture = setup();
  fixture.pr.number = 8;
  expect(await target(fixture.api, 1)).toEqual({ status: 'excluded' });
});

it('CIが不正なPR番号を指す場合はPR資料を取得しない', async () => {
  const fixture = setup();
  fixture.run.pull_requests[0].number = 0;
  expect(await target(fixture.api, 1)).toEqual({ status: 'excluded' });
  expect(fixture.requests).toEqual(['actions/runs/1']);
});

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
  const parents = [{ sha: base }, { sha: 'd'.repeat(40) }];
  const prior: { id: number; body: string; user: { login: string; type: string } }[] = [];
  const api: Api = async <T>(path: string) => {
    requests.push(path);
    if (path.startsWith('actions/')) {
      return run as T;
    }
    if (path === 'pulls/7') {
      return pr as T;
    }
    if (path.startsWith('git/commits/')) {
      return { parents } as T;
    }
    if (path.startsWith('issues/')) {
      return prior as T;
    }
    throw new Error('予期しない呼び出し');
  };
  return { api, requests, run, pr, parents, prior };
}

it('CIの仮想mergeが現在のbaseとheadを親に持つ場合は受理する', async () => {
  const fixture = setup('stale');
  fixture.parents[1].sha = head;
  expect(await target(fixture.api, 1)).toMatchObject({ status: 'ready' });
});
it('他人のPRは再実行者に関係なく除外し資料取得へ進まない', async () => {
  const { api, requests } = setup('other');
  expect(await target(api, 1)).toEqual({ status: 'excluded' });
  expect(requests).toEqual(['actions/runs/1', 'pulls/7']);
});
it('forkはPR取得前に拒否する', async () => {
  const { api, requests } = setup('fork');
  expect(await target(api, 1)).toEqual({ status: 'excluded' });
  expect(requests).toEqual(['actions/runs/1']);
});
it('CI後にheadが変わっていたら実行しない', async () =>
  expect(await target(setup('stale').api, 1)).toEqual({ status: 'excluded' }));
it('本人の最新headを返す', async () =>
  expect(await target(setup().api, 1)).toMatchObject({ status: 'ready', pr: { number: 7 } }));
it('API取得失敗を許可として扱わない', async () => {
  const api: Api = async () => {
    throw new Error('API failed');
  };
  await expect(target(api, 1)).rejects.toThrow();
});

it('CI後にbaseだけ進んだ場合も認証前に拒否する', async () =>
  expect(await target(setup('stale-base').api, 1)).toEqual({ status: 'excluded' }));

it('レビューコメントも100件を超えたら次ページまで取得する', async () => {
  const { reviewComments } = await import('./github.ts');
  const first = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
  const last = { id: 101 };
  const paths: string[] = [];
  const api: Api = async <T>(path: string) => {
    paths.push(path);
    return (path.endsWith('page=1') ? first : [last]) as T;
  };
  expect(await reviewComments(api, 7)).toEqual([...first, last]);
  expect(paths).toEqual([
    'pulls/7/comments?per_page=100&page=1',
    'pulls/7/comments?per_page=100&page=2',
  ]);
});

it('改名後のCI成功を本人PRのレビュー起点として受け付ける', async () => {
  const f = setup();
  f.run.path = '.github/workflows/ci.yml';
  expect(await target(f.api, 1)).toMatchObject({ status: 'ready', pr: { number: 7 } });
});
