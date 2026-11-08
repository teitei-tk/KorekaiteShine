import { expect, it } from 'vitest';
import { inspectReview, finishReview, waitReview } from './wait-review.ts';
import type { Api } from './github.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('完了結果の取得中にPRが閉じても成功を返さない', async () => {
  const f = fixture();
  const api: Api = async <T>(path: string) => {
    const value = await f.api<T>(path);
    if (path === 'actions/runs/20/attempts/1') {
      f.pr.state = 'closed';
    }
    return value;
  };
  expect(await finishReview(api, f.revision, 20, 1)).toEqual({
    conclusion: 'failure',
    target: 'gate',
    reason: 'TARGET_CHANGED',
  });
});
it('取得した完了結果の生成元が違えば拒否する', async () => {
  const f = fixture();
  const api: Api = async <T>(path: string) =>
    path === 'actions/runs/20/attempts/1' ? ({ ...f.review, id: 21 } as T) : f.api<T>(path);
  await expect(finishReview(api, f.revision, 20, 1)).rejects.toThrow('監視結果が不一致');
});
it('完了確認前にPRが閉じたら対象変更を返す', async () => {
  const f = fixture();
  f.pr.state = 'closed';
  expect(await finishReview(f.api, f.revision, 20, 1)).toEqual({
    conclusion: 'failure',
    target: 'gate',
    reason: 'TARGET_CHANGED',
  });
});
it('完了結果の実行IDが不正ならAPIを呼ばない', async () => {
  const f = fixture();
  await expect(finishReview(f.api, f.revision, 0, 1)).rejects.toThrow('監視結果が不正');
  expect(f.calls).toEqual([]);
});
it('仮想mergeの親が対象と異なれば監視を失敗させる', async () => {
  const f = fixture();
  f.source.head_sha = 'c'.repeat(40);
  const api: Api = async <T>(path: string) =>
    path.startsWith('git/commits/') ? ({ parents: [] } as T) : f.api<T>(path);
  expect(await inspectReview(api, f.revision)).toEqual({
    status: 'failure',
    target: 'source-ci',
    reason: 'TARGET_CHANGED',
  });
});
it('仮想mergeのSHAが不正ならコミットを問い合わせない', async () => {
  const f = fixture();
  f.source.head_sha = 'invalid';
  await expect(inspectReview(f.api, f.revision)).rejects.toThrow('起点SHAが不正');
  expect(f.calls.some((path) => path.startsWith('git/commits/'))).toBe(false);
});
it('一覧10ページの上限で停止し無期限に取得しない', async () => {
  const f = fixture();
  let pages = 0;
  const api: Api = async <T>(path: string) => {
    if (path.startsWith('actions/runs?')) {
      pages++;
      return {
        workflow_runs: Array.from({ length: 100 }, (_, i) => ({
          ...f.source,
          id: i + 1,
          created_at: '2026-10-24T00:00:00Z',
        })),
      } as T;
    }
    return f.api<T>(path);
  };
  await expect(inspectReview(api, f.revision)).rejects.toThrow('取得上限');
  expect(pages).toBe(10);
});
it('一覧内の実行IDが不正なら別の成功実行へ読み飛ばさない', async () => {
  const f = fixture();
  f.source.id = 0;
  await expect(inspectReview(f.api, f.revision)).rejects.toThrow('実行IDが不正');
});
it('実行一覧が配列でなければ監視を停止する', async () => {
  const f = fixture();
  const api: Api = async <T>(path: string) =>
    path.startsWith('actions/runs?') ? ({ workflow_runs: null } as T) : f.api<T>(path);
  await expect(inspectReview(api, f.revision)).rejects.toThrow('実行一覧が不正');
});

function fixture(workflow = '.github/workflows/docs.yml') {
  const revision = {
    number: 7,
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    since: '2026-10-25T06:00:00Z',
  };
  const pr = {
    number: 7,
    user: { id: 1324680, type: 'User' },
    state: 'open',
    draft: false,
    head: { sha: revision.head, repo: { id: 1426899426 } },
    base: { sha: revision.base, ref: 'main', repo: { id: 1426899426 } },
  };
  const source = {
    created_at: '2026-10-25T06:00:01Z',
    id: 10,
    run_attempt: 2,
    event: 'pull_request',
    path: workflow,
    status: 'completed',
    conclusion: 'success',
    head_sha: revision.head,
    repository: { id: 1426899426 },
    head_repository: { id: 1426899426 },
    pull_requests: [{ number: 7, head: { sha: revision.head }, base: { sha: revision.base } }],
  };
  const review = {
    id: 20,
    run_attempt: 1,
    event: 'workflow_run',
    path: '.github/workflows/ai-review.yml',
    status: 'completed',
    conclusion: 'success',
    display_title: 'AI review / source run 10 attempt 2 / review',
    repository: { id: 1426899426 },
    head_repository: { id: 1426899426 },
  };
  const reviews = [review];
  const sources = [source];
  const calls: string[] = [];
  const api: Api = async <T>(path: string, method = 'GET') => {
    expect(method).toBe('GET');
    calls.push(path);
    if (path === 'pulls/7') {
      return pr as T;
    }
    if (path.startsWith('actions/runs?')) {
      return { workflow_runs: sources } as T;
    }
    if (path.startsWith('actions/workflows/ai-review.yml/runs?')) {
      return { workflow_runs: reviews } as T;
    }
    if (path === 'actions/runs/20/attempts/1') {
      return review as T;
    }
    if (path.startsWith('git/commits/')) {
      return { parents: [{ sha: revision.base }, { sha: revision.head }] } as T;
    }
    if (path.endsWith('/jobs?per_page=100')) {
      return { jobs: [{ name: 'generate', conclusion: 'failure' }] } as T;
    }
    throw new Error(`Unexpected request ${path}`);
  };
  return { api, revision, pr, source, review, reviews, sources, calls };
}
it('起点CIの最新試行と一致するレビューだけを待つ', async () => {
  const f = fixture();
  f.review.display_title = 'AI review / source run 10 attempt 1 / review';
  expect(await inspectReview(f.api, f.revision)).toEqual({ status: 'pending', target: 'workflow' });
  f.review.display_title = 'AI review / source run 10 attempt 2 / review';
  expect(await inspectReview(f.api, f.revision)).toEqual({
    status: 'complete',
    run: 20,
    attempt: 1,
  });
});
it('headが同じでもbaseの異なる起点CIを使わない', async () => {
  const f = fixture();
  f.source.pull_requests[0].base.sha = 'c'.repeat(40);
  expect(await inspectReview(f.api, f.revision)).toEqual({
    status: 'pending',
    target: 'source-ci',
  });
});
it('別PR・別リポジトリ・別Workflowの実行を成功として扱わない', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.source.pull_requests[0].number = 8;
    },
    (f: ReturnType<typeof fixture>) => {
      f.source.head_repository.id = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.source.path = '.github/workflows/other.yml';
    },
  ]) {
    const f = fixture();
    mutate(f);
    expect((await inspectReview(f.api, f.revision)).status).toBe('pending');
  }
});
it('起点CIの失敗はAIレビュー待ちで停止せず失敗理由を返す', async () => {
  const f = fixture();
  f.source.conclusion = 'failure';
  expect(await inspectReview(f.api, f.revision)).toEqual({
    status: 'failure',
    target: 'source-ci',
    reason: 'EXECUTION_FAILED',
  });
});
it('PR更新後は古い成功を現在のチェックへ反映しない', async () => {
  const f = fixture();
  f.pr.head.sha = 'd'.repeat(40);
  expect(await inspectReview(f.api, f.revision)).toEqual({
    status: 'failure',
    target: 'gate',
    reason: 'TARGET_CHANGED',
  });
});
it('新しい起点CIやレビューの試行が進行中なら旧成功を使わない', async () => {
  const f = fixture();
  f.sources.unshift({ ...f.source, id: 11, status: 'in_progress', conclusion: '' });
  expect((await inspectReview(f.api, f.revision)).status).toBe('pending');
  f.sources.shift();
  f.review.status = 'in_progress';
  f.review.run_attempt = 2;
  expect((await inspectReview(f.api, f.revision)).status).toBe('pending');
});
it('マージコミットで起動した通常CIも両親を検証して照合する', async () => {
  const f = fixture();
  f.source.head_sha = 'c'.repeat(40);
  expect((await inspectReview(f.api, f.revision)).status).toBe('complete');
  expect(f.calls).toContain(`git/commits/${f.source.head_sha}`);
});
it('監視を有界にし、タイムアウトを成功にしない', async () => {
  const f = fixture();
  f.reviews.length = 0;
  let now = 0;
  expect(
    await waitReview(f.api, f.revision, {
      now: () => now,
      sleep: async () => {
        now += 1000;
      },
      timeout: 1500,
    }),
  ).toEqual({ status: 'failure', target: 'workflow', reason: 'TIMED_OUT' });
});
it('取得後に試行が変わったArtifactで成功にしない', async () => {
  const f = fixture();
  f.review.run_attempt = 2;
  expect(await finishReview(f.api, f.revision, 20, 1)).toEqual({
    conclusion: 'failure',
    target: 'workflow',
    reason: 'SUPERSEDED',
  });
});
it('単一Artifactの投稿済み記録を成功にし、欠落は失敗にする', async () => {
  const f = fixture();
  const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-'));
  try {
    expect((await finishReview(f.api, f.revision, 20, 1, directory)).reason).toBe('REPORT_MISSING');
    writeFileSync(
      join(directory, 'status.json'),
      JSON.stringify({
        version: 1,
        run: '20',
        attempt: '1',
        job: 'gate',
        status: 'success',
        target: 'gate',
        reason: 'ALREADY_COMPLETE',
      }),
    );
    expect((await finishReview(f.api, f.revision, 20, 1, directory)).conclusion).toBe('success');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('モデル側の失敗・キャンセルも終端結果として返す', async () => {
  const f = fixture();
  f.review.conclusion = 'failure';
  expect(await finishReview(f.api, f.revision, 20, 1)).toEqual({
    conclusion: 'failure',
    target: 'generate',
    reason: 'EXECUTION_FAILED',
  });
  f.review.conclusion = 'cancelled';
  expect((await finishReview(f.api, f.revision, 20, 1)).reason).toBe('CANCELLED');
});

it('同じrevisionの過去の失敗は今回のCIが現れるまで待つ', async () => {
  const f = fixture();
  f.source.created_at = '2026-10-25T05:59:59Z';
  f.source.conclusion = 'failure';
  expect(await inspectReview(f.api, f.revision)).toEqual({
    status: 'pending',
    target: 'source-ci',
  });
  f.sources.unshift({
    ...f.source,
    id: 11,
    created_at: '2026-10-25T06:00:01Z',
    status: 'in_progress',
    conclusion: '',
  });
  expect((await inspectReview(f.api, f.revision)).status).toBe('pending');
  f.sources[0].status = 'completed';
  f.sources[0].conclusion = 'success';
  f.review.display_title = 'AI review / source run 11 attempt 2 / review';
  expect((await inspectReview(f.api, f.revision)).status).toBe('complete');
});
it('完了結果の取得中に再試行が始まった場合も旧成功を返さない', async () => {
  const f = fixture();
  const api: Api = async <T>(path: string) => {
    const value = await f.api<T>(path);
    if (path === 'actions/runs/20/attempts/1') {
      const frozen = { ...f.review };
      f.review.run_attempt = 2;
      f.review.status = 'in_progress';
      return frozen as T;
    }
    return value;
  };
  const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-rerun-'));
  try {
    writeFileSync(
      join(directory, 'status.json'),
      JSON.stringify({
        version: 1,
        run: '20',
        attempt: '1',
        job: 'publish',
        status: 'success',
        target: 'publish',
        reason: 'REVIEW_COMPLETE',
      }),
    );
    expect(await finishReview(api, f.revision, 20, 1, directory)).toEqual({
      conclusion: 'failure',
      target: 'workflow',
      reason: 'SUPERSEDED',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('監視開始日時が不正なら実行一覧を照合しない', async () => {
  const f = fixture();
  f.revision.since = 'invalid-date';
  await expect(inspectReview(f.api, f.revision)).rejects.toThrow('監視対象が不正です');
  expect(f.calls).toEqual([]);
});
it('存在しない暦日を監視開始日時として受け付けない', async () => {
  const f = fixture();
  f.revision.since = '2026-02-30T00:00:00Z';
  await expect(inspectReview(f.api, f.revision)).rejects.toThrow('監視対象が不正です');
  expect(f.calls).toEqual([]);
});

it('改名前のWorkflowが存在しなくても新CIのレビュー完了を検出する', async () => {
  const f = fixture('.github/workflows/ci.yml');
  expect(await inspectReview(f.api, f.revision)).toEqual({
    status: 'complete',
    run: 20,
    attempt: 1,
  });
  expect(f.calls).toContain('actions/runs?event=pull_request&per_page=100&page=1');
  expect(f.calls.some((path) => path.startsWith('actions/workflows/docs.yml/'))).toBe(false);
});

it.each([
  ['.github/workflows/docs.yml', '.github/workflows/ci.yml'],
  ['.github/workflows/ci.yml', '.github/workflows/docs.yml'],
])('新旧CIが混在しても最新の進行中・失敗を旧成功で隠さない: %s → %s', async (older, newer) => {
  const f = fixture(older);
  f.sources.unshift({
    ...f.source,
    id: 11,
    path: newer,
    created_at: '2026-10-25T06:00:02Z',
    status: 'in_progress',
    conclusion: '',
  });
  expect(await inspectReview(f.api, f.revision)).toEqual({
    status: 'pending',
    target: 'source-ci',
  });
  f.sources[0].status = 'completed';
  f.sources[0].conclusion = 'failure';
  expect(await inspectReview(f.api, f.revision)).toEqual({
    status: 'failure',
    target: 'source-ci',
    reason: 'EXECUTION_FAILED',
  });
});
