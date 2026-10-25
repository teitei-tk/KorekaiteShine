import { expect, it } from 'vitest';
import { inspectReview, finishReview, waitReview } from './wait-review.ts';
import type { Api } from './github.ts';
import type { CheckRequest } from './check-status.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const revision = { number: 7, head: 'a'.repeat(40), base: 'b'.repeat(40) };
  const pr = {
    number: 7,
    user: { id: 1324680, type: 'User' },
    state: 'open',
    draft: false,
    head: { sha: revision.head, repo: { id: 1426899426 } },
    base: { sha: revision.base, ref: 'main', repo: { id: 1426899426 } },
  };
  const source = {
    id: 10,
    run_attempt: 2,
    event: 'pull_request',
    path: '.github/workflows/docs.yml',
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
  const api: Api<CheckRequest> = async <T>(path: string, method = 'GET') => {
    expect(method).toBe('GET');
    calls.push(path);
    if (path === 'pulls/7') return pr as T;
    if (path.startsWith('actions/workflows/docs.yml/runs?')) return { workflow_runs: sources } as T;
    if (path.startsWith('actions/workflows/ai-review.yml/runs?'))
      return { workflow_runs: reviews } as T;
    if (path === 'actions/runs/20/attempts/1') return review as T;
    if (path.startsWith('git/commits/'))
      return { parents: [{ sha: revision.base }, { sha: revision.head }] } as T;
    if (path.endsWith('/jobs?per_page=100'))
      return { jobs: [{ name: 'generate', conclusion: 'failure' }] } as T;
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
