import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateReviewCheck } from './check-status.ts';
import type { Api as GitHubApi } from './github.ts';
import type { CheckRequest } from './check-status.ts';
type Api = GitHubApi<CheckRequest>;
type ApiBody = CheckRequest;

const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
function fixture() {
  const run = {
    id: 20,
    run_attempt: 1,
    event: 'workflow_run',
    path: '.github/workflows/ai-review.yml',
    display_title: 'AI review / source run 10 attempt 1 / review',
    status: 'in_progress',
    conclusion: null as string | null,
    repository: { id: 1426899426 },
    head_repository: { id: 1426899426 },
  };
  const source = {
    event: 'pull_request',
    conclusion: 'success',
    path: '.github/workflows/docs.yml',
    head_sha: head,
    repository: { id: 1426899426 },
    head_repository: { id: 1426899426 },
    pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }],
  };
  const pr = {
    number: 7,
    user: { id: 1324680, type: 'User' },
    state: 'open',
    draft: false,
    head: { sha: head, repo: { id: 1426899426 } },
    base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
  };
  const writes: { path: string; method: string; body: ApiBody | undefined }[] = [];
  const checks: {
    id: number;
    name: string;
    head_sha: string;
    external_id: string;
    status: string;
    conclusion: string | null;
    app: { slug: string };
    details_url: string;
  }[] = [];
  const jobs = [{ name: 'generate', conclusion: 'failure', steps: [] }];
  let latestAttempt = 1;
  const api: Api = async <T>(path: string, method = 'GET', body?: ApiBody) => {
    if (method !== 'GET') {
      writes.push({ path, method, body });
      if (method === 'POST')
        checks.push({
          id: 99,
          name: 'AI review',
          head_sha: head,
          external_id: 'ai-review:20:1',
          status: body?.status ?? 'in_progress',
          conclusion: body?.conclusion ?? null,
          app: { slug: 'github-actions' },
          details_url: 'https://github.com/teitei-tk/KorekaiteShine/actions/runs/20/attempts/1',
        });
      if (method === 'PATCH' && body && 'status' in body) {
        checks[0].status = body.status;
        checks[0].conclusion = body.conclusion ?? null;
      }
      return { id: 99 } as T;
    }
    if (path === 'actions/runs/20') return { ...run, run_attempt: latestAttempt } as T;
    if (path === 'actions/runs/20/attempts/1') return run as T;
    if (path === 'actions/runs/10/attempts/1') return source as T;
    if (path === 'pulls/7') return pr as T;
    if (path.startsWith('commits/')) return { total_count: checks.length, check_runs: checks } as T;
    if (path.includes('/jobs?')) return { total_count: jobs.length, jobs } as T;
    if (path.startsWith('git/commits/')) return { parents: [{ sha: base }, { sha: head }] } as T;
    throw new Error('Unexpected fixture request: ' + path);
  };
  return { api, run, source, pr, writes, checks, jobs, newerAttempt: () => (latestAttempt = 2) };
}
function withReports(job: string, report: object, work: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-status-'));
  const artifact = join(directory, `ai-review-status-20-1-${job}`);
  mkdirSync(artifact);
  writeFileSync(
    join(artifact, 'status.json'),
    JSON.stringify({ version: 1, run: '20', attempt: '1', job, ...report }),
  );
  return work(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
}
it('PRのheadに実行中チェックを登録し、重複開始では増やさない', async () => {
  const f = fixture();
  await updateReviewCheck(f.api, 20, 1, 'in_progress');
  await updateReviewCheck(f.api, 20, 1, 'in_progress');
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toMatchObject({
    path: 'check-runs',
    method: 'POST',
    body: {
      name: 'AI review',
      head_sha: head,
      status: 'in_progress',
      external_id: 'ai-review:20:1',
      details_url: 'https://github.com/teitei-tk/KorekaiteShine/actions/runs/20/attempts/1',
    },
  });
});
it.each(['BUDGET_EXCEEDED', 'MODEL_FAILED', 'PUBLISH_FAILED'])(
  '固定理由 %s と対象IDを失敗チェックへ渡す',
  async (reason) => {
    const f = fixture();
    f.run.status = 'completed';
    f.run.conclusion = 'failure';
    const job = reason === 'PUBLISH_FAILED' ? 'publish' : 'generate';
    await withReports(job, { status: 'failure', target: 'task-2', reason }, async (directory) => {
      await updateReviewCheck(f.api, 20, 1, 'completed', directory);
      expect(f.writes.at(-1)?.body).toMatchObject({
        status: 'completed',
        conclusion: 'failure',
        output: { summary: expect.stringContaining(`対象: task-2、理由: ${reason}`) },
      });
    });
  },
);
it.each(['cancelled', 'timed_out'])(
  '元Workflowの %s を独立通知で終了し、PR更新後も元のチェックを閉じる',
  async (conclusion) => {
    const f = fixture();
    await updateReviewCheck(f.api, 20, 1, 'in_progress');
    f.pr.head.sha = 'c'.repeat(40);
    f.pr.state = 'closed';
    f.run.status = 'completed';
    f.run.conclusion = conclusion;
    await updateReviewCheck(f.api, 20, 1, 'completed');
    expect(f.writes.at(-1)).toMatchObject({
      path: 'check-runs/99',
      method: 'PATCH',
      body: { conclusion, status: 'completed' },
    });
  },
);
it('投稿完了を確認した場合だけ成功とし、遅い開始通知では戻さない', async () => {
  const f = fixture();
  f.run.status = 'completed';
  f.run.conclusion = 'success';
  await withReports(
    'publish',
    { status: 'success', target: 'publish', reason: 'REVIEW_COMPLETE' },
    async (directory) => {
      await updateReviewCheck(f.api, 20, 1, 'completed', directory);
      expect(f.writes.at(-1)?.body).toMatchObject({ conclusion: 'success' });
      const count = f.writes.length;
      await updateReviewCheck(f.api, 20, 1, 'in_progress');
      expect(f.writes).toHaveLength(count);
    },
  );
});
it('正常終了でも投稿の証拠がなければ成功にしない', async () => {
  const f = fixture();
  f.run.status = 'completed';
  f.run.conclusion = 'success';
  await updateReviewCheck(f.api, 20, 1, 'completed');
  expect(f.writes.at(-1)?.body).toMatchObject({
    conclusion: 'failure',
    output: { summary: expect.stringContaining('REPORT_MISSING') },
  });
});
it('投稿前の対象更新は成功ではなくスキップとして表示する', async () => {
  const f = fixture();
  f.run.status = 'completed';
  f.run.conclusion = 'success';
  await withReports(
    'publish',
    { status: 'neutral', target: 'publish', reason: 'TARGET_CHANGED' },
    async (directory) => {
      await updateReviewCheck(f.api, 20, 1, 'completed', directory);
      expect(f.writes.at(-1)?.body).toMatchObject({
        conclusion: 'neutral',
        output: { summary: expect.stringContaining('TARGET_CHANGED') },
      });
    },
  );
});
it.each(['origin', 'reason', 'target'])('不正な結果 %s を生の文面で公開しない', async (kind) => {
  const f = fixture();
  f.run.status = 'completed';
  f.run.conclusion = 'failure';
  const report = {
    status: 'failure',
    target: 'collect',
    reason: 'COLLECTION_FAILED',
    ...(kind === 'origin' ? { attempt: '2' } : { [kind]: 'SECRET\nexternal content' }),
  };
  await withReports('generate', report, async (directory) => {
    await updateReviewCheck(f.api, 20, 1, 'completed', directory);
    expect(JSON.stringify(f.writes)).not.toContain('SECRET');
    expect(f.writes.at(-1)?.body).toMatchObject({
      conclusion: 'failure',
      output: { summary: expect.stringContaining('REPORT_INVALID') },
    });
  });
});
it.each(['fork', 'workflow', 'mode', 'author', 'base', 'sha'])(
  '対象外 %s にはチェックを書き込まない',
  async (kind) => {
    const f = fixture();
    if (kind === 'fork') f.source.head_repository.id = 1;
    if (kind === 'workflow') f.run.path = '.github/workflows/other.yml';
    if (kind === 'mode') f.run.display_title = 'AI review / source run 10 attempt 1 / claims';
    if (kind === 'author') f.pr.user.id = 1;
    if (kind === 'base') f.pr.base.ref = 'other';
    if (kind === 'sha') f.source.pull_requests[0].head.sha = 'bad';
    await updateReviewCheck(f.api, 20, 1, 'in_progress');
    expect(f.writes).toEqual([]);
  },
);
it('新しい試行の開始後に古いチェックを新規作成しない', async () => {
  const f = fixture();
  f.newerAttempt();
  await updateReviewCheck(f.api, 20, 1, 'in_progress');
  expect(f.writes).toEqual([]);
});
it('新しい試行があれば古い実行中チェックだけを終了する', async () => {
  const f = fixture();
  await updateReviewCheck(f.api, 20, 1, 'in_progress');
  f.newerAttempt();
  await updateReviewCheck(f.api, 20, 1, 'completed');
  expect(f.writes.at(-1)).toMatchObject({
    path: 'check-runs/99',
    body: { conclusion: 'cancelled', output: { summary: expect.stringContaining('SUPERSEDED') } },
  });
});
it('資料収集前にジョブが失敗し記録がなくても失敗対象を表示する', async () => {
  const f = fixture();
  f.run.status = 'completed';
  f.run.conclusion = 'failure';
  await updateReviewCheck(f.api, 20, 1, 'completed');
  expect(f.writes.at(-1)?.body).toMatchObject({
    conclusion: 'failure',
    output: { summary: expect.stringContaining('対象: generate、理由: EXECUTION_FAILED') },
  });
});
it('試行を終えた後の再実行は過去の成功結果をキャンセルに書き換えない', async () => {
  const f = fixture();
  f.run.status = 'completed';
  f.run.conclusion = 'success';
  await withReports(
    'publish',
    { status: 'success', target: 'publish', reason: 'REVIEW_COMPLETE' },
    async (directory) => {
      await updateReviewCheck(f.api, 20, 1, 'completed', directory);
      // POSTで完了したチェックをAPI側でも完了として保持する。
      f.checks[0].status = 'completed';
      f.newerAttempt();
      const count = f.writes.length;
      await updateReviewCheck(f.api, 20, 1, 'completed');
      expect(f.writes).toHaveLength(count);
    },
  );
});
it('PRの仮想mergeコミットを検査したCIでもチェックはPR headに紐付ける', async () => {
  const f = fixture();
  f.source.head_sha = 'd'.repeat(40);
  await updateReviewCheck(f.api, 20, 1, 'in_progress');
  expect(f.writes[0].body).toMatchObject({ head_sha: head });
});
it('起点CIが再実行されても実行名に固定した試行のSHAで通知する', async () => {
  const f = fixture();
  f.run.display_title = 'AI review / source run 10 attempt 1 / review';
  const api: Api = async <T>(path: string, method?: string, body?: ApiBody) => {
    if (path === 'actions/runs/10') return { ...f.source, conclusion: 'failure' } as T;
    if (path === 'actions/runs/10/attempts/1') return f.source as T;
    return f.api<T>(path, method, body);
  };
  await updateReviewCheck(api, 20, 1, 'in_progress');
  expect(f.writes[0]?.body).toMatchObject({ head_sha: head, status: 'in_progress' });
});
it('投稿確認済みの成功は後日の通知再実行でArtifactが失効しても維持する', async () => {
  const f = fixture();
  f.run.status = 'completed';
  f.run.conclusion = 'success';
  await withReports(
    'publish',
    { status: 'success', target: 'publish', reason: 'REVIEW_COMPLETE' },
    async (directory) => {
      await updateReviewCheck(f.api, 20, 1, 'completed', directory);
    },
  );
  const count = f.writes.length;
  await updateReviewCheck(f.api, 20, 1, 'completed');
  expect(f.writes).toHaveLength(count);
});
it.each(['success', 'failure', 'wrong-origin', 'mixed-layout'])(
  '単一Artifactの直下展開を検証してチェックへ反映する: %s',
  async (scenario) => {
    const f = fixture();
    f.run.status = 'completed';
    f.run.conclusion = scenario === 'failure' ? 'failure' : 'success';
    const directory = mkdtempSync(join(tmpdir(), 'single-status-'));
    try {
      const report = {
        version: 1,
        run: scenario === 'wrong-origin' ? '21' : '20',
        attempt: '1',
        job: scenario === 'failure' ? 'generate' : 'publish',
        status: scenario === 'failure' ? 'failure' : 'success',
        target: scenario === 'failure' ? 'collect' : 'publish',
        reason: scenario === 'failure' ? 'BUDGET_EXCEEDED' : 'REVIEW_COMPLETE',
      };
      writeFileSync(join(directory, 'status.json'), JSON.stringify(report));
      if (scenario === 'mixed-layout') {
        const subdirectory = join(directory, 'ai-review-status-20-1-publish');
        mkdirSync(subdirectory);
        writeFileSync(join(subdirectory, 'status.json'), JSON.stringify(report));
      }
      await updateReviewCheck(f.api, 20, 1, 'completed', directory);
      expect(f.writes.at(-1)?.body).toMatchObject({
        conclusion: scenario === 'success' ? 'success' : 'failure',
        output: {
          summary: expect.stringContaining(
            scenario === 'success'
              ? 'REVIEW_COMPLETE'
              : scenario === 'failure'
                ? '対象: collect、理由: BUDGET_EXCEEDED'
                : 'REPORT_INVALID',
          ),
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
it.each(['gate', 'collect'])(
  '投稿済みの%s確認から単一Artifactを経て成功表示し再生成しない',
  async (mode) => {
    const { prepareReview } = await import('./prepare.ts');
    const f = fixture();
    f.run.status = 'completed';
    f.run.conclusion = 'success';
    const directory = mkdtempSync(join(tmpdir(), 'already-complete-'));
    try {
      const api: GitHubApi = async <T>(path: string) => {
        if (path === 'actions/runs/10') return f.source as T;
        if (path === 'pulls/7') return f.pr as T;
        if (path.startsWith('issues/7/comments?'))
          return [
            {
              id: 1,
              user: { login: 'github-actions[bot]', type: 'Bot' },
              body: `<!-- korekaite-ai-review -->\n<!-- revision:${head}:${base} -->`,
            },
          ] as T;
        throw new Error('Unexpected preparation request');
      };
      let collections = 0;
      const env = {
        SOURCE_RUN_ID: '10',
        AI_REVIEW_MODE: 'review',
        GITHUB_RUN_ID: '20',
        GITHUB_RUN_ATTEMPT: '1',
        AI_REVIEW_JOB: mode === 'gate' ? 'gate' : 'generate',
        AI_REVIEW_REPORT: join(directory, 'status.json'),
        GITHUB_OUTPUT: join(directory, 'output'),
      };
      await prepareReview(mode, env, api, () => {
        collections++;
        throw new Error('再収集してはいけない');
      });
      expect(collections).toBe(0);
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('allowed=false\n');
      expect(JSON.parse(readFileSync(env.AI_REVIEW_REPORT, 'utf8'))).toMatchObject({
        status: 'success',
        reason: 'ALREADY_COMPLETE',
      });
      await updateReviewCheck(f.api, 20, 1, 'completed', directory);
      expect(f.writes.at(-1)?.body).toMatchObject({
        conclusion: 'success',
        output: { summary: expect.stringContaining('ALREADY_COMPLETE') },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
