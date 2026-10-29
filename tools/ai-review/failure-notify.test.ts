import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notifyFailure } from './failure-notify.ts';
import type { Api, Comment } from './github.ts';
import { prFixture } from './policy.test.ts';

function fixture(reason = 'OUTPUT_INVALID') {
  const pr = prFixture();
  const run = {
    id: 20,
    run_attempt: 1,
    event: 'workflow_run',
    path: '.github/workflows/ai-review.yml',
    head_branch: 'main',
    display_title: 'AI review / source run 10 attempt 1 / review',
    status: 'completed',
    conclusion: 'failure',
    repository: { id: 1426899426 },
    head_repository: { id: 1426899426 },
  };
  const source = {
    id: 10,
    run_attempt: 1,
    event: 'pull_request',
    conclusion: 'success',
    path: '.github/workflows/docs.yml',
    head_sha: pr.head.sha,
    repository: { id: 1426899426 },
    head_repository: { id: 1426899426 },
    pull_requests: [{ number: pr.number, head: { sha: pr.head.sha }, base: { sha: pr.base.sha } }],
  };
  const directory = mkdtempSync(join(tmpdir(), 'review-failure-notify-'));
  writeFileSync(
    join(directory, 'status.json'),
    JSON.stringify({
      version: 1,
      run: '20',
      attempt: '1',
      job: 'generate',
      status: 'failure',
      target: 'task-1',
      reason,
      diagnostic: { subcode: 'CHECK_TARGET_MISMATCH', missing: [] },
    }),
  );
  const prior: Comment[] = [],
    posted: string[] = [];
  let failPost = false,
    changeOnComments = false,
    commentReads = 0;
  const api: Api = async <T>(
    path: string,
    method?: string,
    body?: import('./github.ts').ApiBody,
  ) => {
    if (method) {
      expect(path).toBe('issues/7/comments');
      expect(method).toBe('POST');
      if (failPost) throw new Error('SECRET_EXTERNAL_ERROR');
      if (!body || !('body' in body)) throw new Error('missing body');
      posted.push(body.body);
      const comment = {
        id: 100,
        body: body.body,
        user: { id: 41898282, login: 'github-actions[bot]', type: 'Bot' },
      };
      prior.push(comment);
      return comment as T;
    }
    if (path === 'actions/runs/20' || path === 'actions/runs/20/attempts/1') return run as T;
    if (path === 'actions/runs/10') return source as T;
    if (path.startsWith('actions/runs/20/attempts/1/jobs'))
      return { jobs: [{ name: 'generate', conclusion: 'failure' }] } as T;
    if (path === 'pulls/7') return pr as T;
    if (path.startsWith('issues/7/comments')) {
      commentReads++;
      if (changeOnComments && commentReads === 2) pr.head.sha = 'c'.repeat(40);
      return prior as T;
    }
    throw new Error('Unexpected path: ' + path);
  };
  return {
    api,
    run,
    source,
    pr,
    directory,
    prior,
    posted,
    setFailPost: () => {
      failPost = true;
    },
    setChange: () => {
      changeOnComments = true;
    },
  };
}
it.each([
  'TARGET_FAILED',
  'HISTORY_FAILED',
  'COLLECTION_FAILED',
  'AUTH_FAILED',
  'TOKEN_COUNT_FAILED',
  'MODEL_FAILED',
  'OUTPUT_INVALID',
  'ARTIFACT_INVALID',
  'PUBLISH_FAILED',
  'TIME_BUDGET_EXCEEDED',
])('各段階の失敗を固定理由と実行リンクで通知する: %s', async (reason) => {
  const f = fixture(reason);
  expect(await notifyFailure(f.api, 20, 1, f.directory)).toMatchObject({
    status: 'notified',
    commentId: 100,
  });
  expect(f.posted[0]).toContain(reason);
  expect(f.posted[0]).toContain('CHECK_TARGET_MISMATCH');
  expect(f.posted[0]).toContain(
    'https://github.com/teitei-tk/KorekaiteShine/actions/runs/20/attempts/1',
  );
  expect(f.posted[0]).not.toContain('SECRET');
});
it('同じ実行・試行は重複投稿しない', async () => {
  const f = fixture();
  await notifyFailure(f.api, 20, 1, f.directory);
  await notifyFailure(f.api, 20, 1, f.directory);
  expect(f.posted).toHaveLength(1);
});
it('人間が同じ本文を投稿してもbot通知済みとして信用しない', async () => {
  const f = fixture();
  await notifyFailure(f.api, 20, 1, f.directory);
  f.prior[0].user = { id: 1, login: 'user', type: 'User' };
  await notifyFailure(f.api, 20, 1, f.directory);
  expect(f.posted).toHaveLength(2);
});
it.each(['source', 'repo', 'branch', 'attempt', 'head', 'draft'])(
  '対象不一致には投稿しない: %s',
  async (scenario) => {
    const f = fixture();
    if (scenario === 'source') f.source.path = '.github/workflows/other.yml';
    if (scenario === 'repo') f.run.repository.id = 1;
    if (scenario === 'branch') f.run.head_branch = 'feature';
    if (scenario === 'attempt') f.run.run_attempt = 2;
    if (scenario === 'head') f.pr.head.sha = 'c'.repeat(40);
    if (scenario === 'draft') f.pr.draft = true;
    expect(await notifyFailure(f.api, 20, 1, f.directory)).toMatchObject({ status: 'skipped' });
    expect(f.posted).toHaveLength(0);
  },
);
it('コメント取得中にheadが変われば投稿しない', async () => {
  const f = fixture();
  f.setChange();
  await notifyFailure(f.api, 20, 1, f.directory);
  expect(f.posted).toHaveLength(0);
});
it.each(['cancelled', 'timed_out'])('Artifactがなくても%sを通知する', async (conclusion) => {
  const f = fixture();
  f.run.conclusion = conclusion;
  await notifyFailure(f.api, 20, 1);
  expect(f.posted[0]).toContain(conclusion === 'cancelled' ? 'CANCELLED' : 'TIMED_OUT');
});
it('記録前の失敗や取得失敗も固定理由で通知する', async () => {
  const f = fixture();
  await notifyFailure(f.api, 20, 1);
  expect(f.posted[0]).toContain('EXECUTION_FAILED');
});
it('不正な診断・本文をそのまま通知しない', async () => {
  const f = fixture('SECRET_MODEL_OUTPUT');
  await notifyFailure(f.api, 20, 1, f.directory);
  expect(f.posted[0]).toContain('REPORT_INVALID');
  expect(f.posted[0]).not.toContain('SECRET');
});
it('成功・予算通知済みでは失敗コメントを投稿しない', async () => {
  const f = fixture();
  f.run.conclusion = 'success';
  writeFileSync(
    join(f.directory, 'status.json'),
    JSON.stringify({
      version: 1,
      run: '20',
      attempt: '1',
      job: 'publish',
      status: 'success',
      target: 'publish',
      reason: 'BUDGET_NOTIFIED',
      commentId: 99,
    }),
  );
  await notifyFailure(f.api, 20, 1, f.directory);
  expect(f.posted).toHaveLength(0);
});
it('通知API失敗は成功扱いしない', async () => {
  const f = fixture();
  f.setFailPost();
  await expect(notifyFailure(f.api, 20, 1, f.directory)).rejects.toThrow();
  expect(f.posted).toHaveLength(0);
});

it('成功実行のArtifactが取得不能・期限切れでも失敗通知しない', async () => {
  const f = fixture();
  f.run.conclusion = 'success';
  expect(await notifyFailure(f.api, 20, 1)).toMatchObject({ status: 'skipped' });
  expect(f.posted).toHaveLength(0);
});

it('未解決参照を日本語の原因・対処で説明し、機械用コードは詳細に収める', async () => {
  const f = fixture('UNRESOLVED_REFERENCE');
  await notifyFailure(f.api, 20, 1, f.directory);
  const body = f.posted[0];
  expect(body).toContain('参照先のファイルを見つけられず');
  expect(body).toContain('import先やリンク先');
  expect(body).toContain('<summary>調査用の詳細</summary>');
  expect(body.indexOf('UNRESOLVED_REFERENCE')).toBeGreaterThan(body.indexOf('<details>'));
});

it('処理上限の通知は容量に断定せず、件数・時間も含めて実行記録の確認を案内する', async () => {
  const f = fixture('BUDGET_EXCEEDED');
  await notifyFailure(f.api, 20, 1, f.directory);
  const body = f.posted[0];
  expect(body).toContain('容量・件数・時間のいずれかの処理上限');
  expect(body).toContain('実行記録で停止した処理と該当する上限を確認してください');
  expect(body).toContain('料金の上限超過を示すものではありません');
  expect(body).not.toContain('容量を超えました');
  expect(body).not.toContain('PRを関連する変更ごとに分割してください');
  expect(body).toContain('https://github.com/teitei-tk/KorekaiteShine/actions/runs/20/attempts/1');
});
it('確認対象の不一致の内訳をArtifactからPRへ日本語で表示する', async () => {
  const { coverageDiagnostic } = await import('./coverage-diagnostic.ts');
  const f = fixture();
  const coverage = coverageDiagnostic(
    ['a'.repeat(16), 'b'.repeat(16)],
    ['a'.repeat(16), 'a'.repeat(16), 'SECRET'],
  );
  writeFileSync(
    join(f.directory, 'status.json'),
    JSON.stringify({
      version: 1,
      run: '20',
      attempt: '1',
      job: 'generate',
      status: 'failure',
      target: 'task-1',
      reason: 'OUTPUT_INVALID',
      diagnostic: { subcode: 'COVERAGE_MISMATCH', missing: [], coverage },
    }),
  );
  await notifyFailure(f.api, 20, 1, f.directory);
  expect(f.posted[0]).toContain('期待2件、回答3件');
  expect(f.posted[0]).toContain('欠落1件、重複1件');
  expect(f.posted[0]).toContain('担当外1件');
  expect(f.posted[0]).toContain('b'.repeat(16));
  expect(f.posted[0]).not.toContain('SECRET');
});

it('出力不足は料金超過と区別してPRに日本語で通知する', async () => {
  const f = fixture('INCOMPLETE');
  writeFileSync(
    join(f.directory, 'status.json'),
    JSON.stringify({
      version: 1,
      run: '20',
      attempt: '1',
      job: 'generate',
      status: 'failure',
      target: 'task-1',
      reason: 'INCOMPLETE',
      diagnostic: { subcode: 'TOKEN_LIMIT', missing: [] },
    }),
  );
  await notifyFailure(f.api, 20, 1, f.directory);
  expect(f.posted[0]).toContain('AIの推論・回答');
  expect(f.posted[0]).toContain('料金の上限超過ではありません');
  expect(f.posted[0]).toContain('actions/runs/20/attempts/1');
});
it.each(['failure', 'cancelled', 'timed_out'])(
  '投稿開始後の%sは履歴を変えず既存チェックに残す',
  async (conclusion) => {
    const f = fixture('PUBLISH_FAILED');
    f.run.conclusion = conclusion;
    const api: Api = async <T>(
      path: string,
      method?: string,
      body?: import('./github.ts').ApiBody,
    ) => {
      if (path.startsWith('actions/runs/20/attempts/1/jobs'))
        return {
          jobs: [
            { name: 'generate', conclusion: 'success' },
            { name: 'publish', conclusion },
          ],
        } as T;
      return f.api<T>(path, method, body);
    };
    expect(await notifyFailure(api, 20, 1, f.directory)).toEqual({ status: 'skipped' });
    expect(f.posted).toHaveLength(0);
  },
);
