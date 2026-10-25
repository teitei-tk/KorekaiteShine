import { renderDiagnostic } from './diagnostics.ts';
import type { Diagnostic } from './diagnostics.ts';
import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { githubApi } from './github.ts';
import type { Api, Run } from './github.ts';
import { completedOutcome } from './check-status.ts';
import type { ReviewRun } from './check-status.ts';
import { eligible, REPOSITORY, REPOSITORY_ID } from './policy.ts';
import type { PullRequest } from './policy.ts';
import type { StatusReason } from './status-report.ts';

interface Revision {
  number: number;
  head: string;
  base: string;
  since: string;
}
interface SourceRun extends Run {
  created_at: string;
  id: number;
  run_attempt: number;
  status: string;
}
type ReadApi = Api;
type Failure = { status: 'failure'; target: string; reason: StatusReason };
type Inspection =
  | { status: 'pending'; target: string }
  | { status: 'complete'; run: number; attempt: number }
  | Failure;
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function validRevision(revision: Revision): boolean {
  return (
    Number.isFinite(Date.parse(revision.since)) &&
    positive(revision.number) &&
    /^[a-f0-9]{40}$/.test(revision.head) &&
    /^[a-f0-9]{40}$/.test(revision.base)
  );
}
// APIの降順一覧から最初に一致した実行を選ぶ。最新試行が進行中なら旧成功へ戻らない。
async function latest<T extends { id: number; run_attempt: number }>(
  api: ReadApi,
  workflow: string,
  event: string,
  match: (run: T) => boolean,
): Promise<T | undefined> {
  for (let page = 1; page <= 10; page++) {
    const data = await api<{ workflow_runs: T[] }>(
      `actions/workflows/${workflow}/runs?event=${event}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(data?.workflow_runs)) throw new Error('実行一覧が不正です');
    for (const run of data.workflow_runs) {
      if (!run || !positive(run.id) || !positive(run.run_attempt))
        throw new Error('実行IDが不正です');
      if (match(run)) return run;
    }
    if (data.workflow_runs.length < 100) return;
  }
  throw new Error('実行一覧の取得上限に達しました');
}
export async function inspectReview(api: ReadApi, revision: Revision): Promise<Inspection> {
  if (!validRevision(revision)) throw new Error('監視対象が不正です');
  const pr = await api<PullRequest>(`pulls/${revision.number}`);
  if (
    !eligible(pr) ||
    pr.number !== revision.number ||
    pr.head.sha !== revision.head ||
    pr.base.sha !== revision.base
  )
    return { status: 'failure', target: 'gate', reason: 'TARGET_CHANGED' };
  const source = await latest<SourceRun>(
    api,
    'docs.yml',
    'pull_request',
    (run) =>
      Date.parse(run.created_at) >= Date.parse(revision.since) &&
      run.event === 'pull_request' &&
      run.path === '.github/workflows/docs.yml' &&
      run.repository?.id === REPOSITORY_ID &&
      run.head_repository?.id === REPOSITORY_ID &&
      run.pull_requests?.length === 1 &&
      run.pull_requests[0]?.number === revision.number &&
      run.pull_requests[0]?.head?.sha === revision.head &&
      run.pull_requests[0]?.base?.sha === revision.base,
  );
  if (!source || source.status !== 'completed') return { status: 'pending', target: 'source-ci' };
  if (source.conclusion !== 'success')
    return { status: 'failure', target: 'source-ci', reason: 'EXECUTION_FAILED' };
  if (source.head_sha !== revision.head) {
    if (!/^[a-f0-9]{40}$/.test(source.head_sha)) throw new Error('起点SHAが不正です');
    const commit = await api<{ parents: { sha: string }[] }>(`git/commits/${source.head_sha}`);
    if (
      commit.parents?.length !== 2 ||
      commit.parents[0]?.sha !== revision.base ||
      commit.parents[1]?.sha !== revision.head
    )
      return { status: 'failure', target: 'source-ci', reason: 'TARGET_CHANGED' };
  }
  const review = await latest<ReviewRun>(
    api,
    'ai-review.yml',
    'workflow_run',
    (run) =>
      run.event === 'workflow_run' &&
      run.path === '.github/workflows/ai-review.yml' &&
      run.repository?.id === REPOSITORY_ID &&
      run.head_repository?.id === REPOSITORY_ID &&
      run.display_title ===
        `AI review / source run ${source.id} attempt ${source.run_attempt} / review`,
  );
  if (!review || review.status !== 'completed') return { status: 'pending', target: 'workflow' };
  return { status: 'complete', run: review.id, attempt: review.run_attempt };
}
export async function waitReview(
  api: ReadApi,
  revision: Revision,
  clock = {
    now: Date.now,
    sleep: async () => {
      await setTimeout(15_000);
    },
    timeout: 50 * 60_000,
  },
): Promise<Exclude<Inspection, { status: 'pending' }>> {
  const deadline = clock.now() + clock.timeout;
  let target = 'workflow';
  while (clock.now() < deadline) {
    const result = await inspectReview(api, revision);
    if (result.status !== 'pending') return result;
    target = result.target;
    await clock.sleep();
  }
  return { status: 'failure', target, reason: 'TIMED_OUT' };
}
export async function finishReview(
  api: ReadApi,
  revision: Revision,
  id: number,
  attempt: number,
  directory?: string,
) {
  if (!positive(id) || !positive(attempt)) throw new Error('監視結果が不正です');
  const current = await inspectReview(api, revision);
  if (current.status === 'failure')
    return { conclusion: 'failure' as const, target: current.target, reason: current.reason };
  if (current.status !== 'complete' || current.run !== id || current.attempt !== attempt)
    return { conclusion: 'failure' as const, target: 'workflow', reason: 'SUPERSEDED' as const };
  const run = await api<ReviewRun>(`actions/runs/${id}/attempts/${attempt}`);
  if (
    run.id !== id ||
    run.run_attempt !== attempt ||
    run.status !== 'completed' ||
    run.event !== 'workflow_run' ||
    run.path !== '.github/workflows/ai-review.yml' ||
    run.repository?.id !== REPOSITORY_ID ||
    run.head_repository?.id !== REPOSITORY_ID
  )
    throw new Error('監視結果が不一致です');
  const result = await completedOutcome(api, run, directory);
  const after = await inspectReview(api, revision);
  if (after.status === 'failure')
    return { conclusion: 'failure' as const, target: after.target, reason: after.reason };
  if (after.status !== 'complete' || after.run !== id || after.attempt !== attempt)
    return { conclusion: 'failure' as const, target: 'workflow', reason: 'SUPERSEDED' as const };
  return result;
}
function summary(
  target: string,
  reason: StatusReason,
  run?: number,
  attempt?: number,
  diagnostic?: Diagnostic,
  commentId?: number,
): void {
  const message = `対象: ${target}、理由: ${reason}。${diagnostic ? '\n\n' + renderDiagnostic(diagnostic) : ''}`;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${message}\n\n${run ? `[AIレビューの実行ログ](https://github.com/${REPOSITORY}/actions/runs/${run}/attempts/${attempt})\n\n` : ''}${reason === 'BUDGET_NOTIFIED' ? `予算不足・レビュー未完了・[PR通知済み](https://github.com/${REPOSITORY}/issues/${process.env.REVIEW_PR}#issuecomment-${commentId})。CI成功は通知処理の完了です。` : '成功はレビューと投稿の完了を表します。'}指摘のResolveは人間が行います。\n`,
    );
  console.log(message);
}
if (import.meta.main) {
  try {
    const api = githubApi(process.env.GH_TOKEN ?? '');
    const revision = {
      number: Number(process.env.REVIEW_PR),
      head: process.env.REVIEW_HEAD ?? '',
      base: process.env.REVIEW_BASE ?? '',
      since: process.env.REVIEW_SINCE ?? '',
    };
    if (process.argv[2] === 'wait') {
      const result = await waitReview(api, revision);
      if (result.status === 'complete') {
        if (!process.env.GITHUB_OUTPUT) throw new Error('出力先がありません');
        appendFileSync(process.env.GITHUB_OUTPUT, `run=${result.run}\nattempt=${result.attempt}\n`);
      } else {
        summary(result.target, result.reason);
        console.error(`::error::${result.reason} (${result.target})`);
        process.exitCode = 1;
      }
    } else if (process.argv[2] === 'finish') {
      const id = Number(process.env.REVIEW_RUN_ID),
        attempt = Number(process.env.REVIEW_RUN_ATTEMPT);
      const result = await finishReview(
        api,
        revision,
        id,
        attempt,
        process.env.REVIEW_REPORT_DOWNLOAD === 'success'
          ? process.env.REVIEW_REPORT_DIRECTORY
          : undefined,
      );
      summary(result.target, result.reason, id, attempt, result.diagnostic, result.commentId);
      if (result.conclusion !== 'success' && result.conclusion !== 'neutral') {
        console.error(
          `::error::${result.reason}${result.diagnostic ? '/' + result.diagnostic.subcode : ''} (${result.target})`,
        );
        process.exitCode = 1;
      }
    } else throw new Error('監視操作が不正です');
  } catch {
    summary('monitor', 'EXECUTION_FAILED');
    console.error('::error::EXECUTION_FAILED (monitor)');
    process.exitCode = 1;
  }
}
