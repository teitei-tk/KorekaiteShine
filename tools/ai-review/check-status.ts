import { githubApi } from './github.ts';
import type { Api as GitHubApi, Run } from './github.ts';
import { eligible, REPOSITORY, REPOSITORY_ID } from './policy.ts';
import type { PullRequest } from './policy.ts';
import { readStatusReports } from './status-report.ts';
import type { StatusReason } from './status-report.ts';

export interface ReviewRun {
  id: number;
  run_attempt: number;
  event: string;
  path: string;
  display_title: string;
  status: string;
  conclusion: string | null;
  repository: { id: number };
  head_repository: { id: number };
}
interface CheckInput {
  id: number;
  name: string;
  head_sha: string;
  external_id: string;
  status: string;
  conclusion: string | null;
  app: { slug: string };
  details_url: string;
}
export interface CheckBody {
  name: 'AI review';
  head_sha: string;
  external_id: string;
  details_url: string;
  status: 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out';
  output: { title: string; summary: string };
}
export type CheckRequest = CheckBody | Omit<CheckBody, 'head_sha'>;
type Api = GitHubApi<CheckRequest>;
interface Outcome {
  conclusion: NonNullable<CheckBody['conclusion']>;
  target: string;
  reason: StatusReason;
}
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function sha(value: string): boolean {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}
function trustedRun(run: ReviewRun, id: number): boolean {
  return (
    !!run &&
    run.id === id &&
    positive(run.run_attempt) &&
    run.event === 'workflow_run' &&
    run.path === '.github/workflows/ai-review.yml' &&
    run.repository?.id === REPOSITORY_ID &&
    run.head_repository?.id === REPOSITORY_ID
  );
}
async function existingCheck(
  api: Api,
  head: string,
  externalId: string,
  url: string,
): Promise<CheckInput | undefined> {
  for (let page = 1; page <= 10; page++) {
    const data = await api<{ check_runs: CheckInput[] }>(
      `commits/${head}/check-runs?check_name=AI%20review&filter=all&per_page=100&page=${page}`,
    );
    if (!Array.isArray(data?.check_runs)) throw new Error('チェック応答が不正です');
    const check = data.check_runs.find(
      (c) =>
        c?.external_id === externalId &&
        c.name === 'AI review' &&
        c.head_sha === head &&
        c.app?.slug === 'github-actions' &&
        (c.details_url === url ||
          c.details_url === `https://github.com/${REPOSITORY}/runs/${c.id}`),
    );
    if (check) {
      if (!positive(check.id) || !['queued', 'in_progress', 'completed'].includes(check.status))
        throw new Error('チェックが不正です');
      return check;
    }
    if (data.check_runs.length < 100) return;
  }
  throw new Error('チェック取得上限を超えました');
}
export async function completedOutcome(
  api: Api,
  run: ReviewRun,
  directory?: string,
): Promise<Outcome> {
  if (run.conclusion === 'cancelled')
    return { conclusion: 'cancelled', target: 'workflow', reason: 'CANCELLED' };
  if (run.conclusion === 'timed_out')
    return { conclusion: 'timed_out', target: 'workflow', reason: 'TIMED_OUT' };
  let reports;
  try {
    reports = readStatusReports(directory, run.id, run.run_attempt);
  } catch {
    return { conclusion: 'failure', target: 'artifact', reason: 'REPORT_INVALID' };
  }
  const failure = reports.find((r) => r.status === 'failure');
  if (failure) return { conclusion: 'failure', target: failure.target, reason: failure.reason };
  if (run.conclusion !== 'success') {
    // 記録前の失敗（checkout、依存導入、Artifact取得など）にも安全な固定理由を付ける。
    let target = 'workflow';
    try {
      const data = await api<{ jobs: { name: string; conclusion: string | null }[] }>(
        `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      );
      const job = data.jobs.find(
        (j) =>
          ['failure', 'timed_out', 'cancelled'].includes(j.conclusion ?? '') &&
          ['gate', 'generate', 'publish'].includes(j.name),
      );
      if (job) target = job.name;
    } catch {
      /* 詳細取得失敗でも元実行の失敗を閉じる。 */
    }
    return {
      conclusion: 'failure',
      target,
      reason: target === 'publish' ? 'PUBLISH_FAILED' : 'EXECUTION_FAILED',
    };
  }
  const skipped = reports.find((r) => r.status === 'neutral');
  if (skipped) return { conclusion: 'neutral', target: skipped.target, reason: skipped.reason };
  const posted = reports.find((r) => r.status === 'success');
  if (posted) return { conclusion: 'success', target: posted.target, reason: posted.reason };
  return { conclusion: 'failure', target: 'artifact', reason: 'REPORT_MISSING' };
}
export async function updateReviewCheck(
  api: Api,
  runId: number,
  attempt: number,
  phase: string,
  directory?: string,
): Promise<void> {
  if (!positive(runId) || !positive(attempt) || !['in_progress', 'completed'].includes(phase))
    throw new Error('通知入力が不正です');
  const latest = await api<ReviewRun>(`actions/runs/${runId}`);
  const run = await api<ReviewRun>(`actions/runs/${runId}/attempts/${attempt}`);
  if (!trustedRun(latest, runId) || !trustedRun(run, runId) || run.run_attempt !== attempt) return;
  const match =
    typeof run.display_title === 'string'
      ? /^AI review \/ source run ([1-9]\d{0,17}) attempt ([1-9]\d{0,5}) \/ review$/.exec(
          run.display_title,
        )
      : null;
  if (!match || !positive(Number(match[1])) || !positive(Number(match[2]))) return;
  const source = await api<Run>(`actions/runs/${match[1]}/attempts/${match[2]}`);
  if (
    !source ||
    source.event !== 'pull_request' ||
    source.conclusion !== 'success' ||
    source.path !== '.github/workflows/docs.yml' ||
    source.repository?.id !== REPOSITORY_ID ||
    source.head_repository?.id !== REPOSITORY_ID ||
    !Array.isArray(source.pull_requests) ||
    source.pull_requests.length !== 1
  )
    return;
  const revision = source.pull_requests[0];
  if (
    !revision ||
    !positive(revision.number) ||
    !sha(revision.head?.sha) ||
    !sha(revision.base?.sha) ||
    !sha(source.head_sha)
  )
    return;
  if (source.head_sha !== revision.head.sha) {
    const commit = await api<{ parents: { sha: string }[] }>(`git/commits/${source.head_sha}`);
    if (
      !Array.isArray(commit?.parents) ||
      commit.parents.length !== 2 ||
      commit.parents[0]?.sha !== revision.base.sha ||
      commit.parents[1]?.sha !== revision.head.sha
    )
      return;
  }
  const externalId = `ai-review:${runId}:${attempt}`;
  const url = `https://github.com/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`;
  const check = await existingCheck(api, revision.head.sha, externalId, url);
  if (!check) {
    if (latest.run_attempt !== attempt) return;
    const pr = await api<PullRequest>(`pulls/${revision.number}`);
    if (
      !eligible(pr) ||
      pr.number !== revision.number ||
      pr.head.sha !== revision.head.sha ||
      pr.base.sha !== revision.base.sha
    )
      return;
  }
  const superseded = latest.run_attempt > attempt;
  if (check?.status === 'completed' && check.conclusion === 'success') return;
  if (superseded && check?.status === 'completed') return;
  // 完了通知が先に届いても、遅延した開始通知で実行中に戻さない。
  if (phase === 'in_progress' && check && !superseded) return;
  const result: Outcome | undefined = superseded
    ? { conclusion: 'cancelled', target: 'workflow', reason: 'SUPERSEDED' }
    : phase === 'completed' && run.status === 'completed'
      ? await completedOutcome(api, run, directory)
      : undefined;
  if (phase === 'completed' && !result) throw new Error('元実行がまだ完了していません');
  const body: CheckBody = {
    name: 'AI review',
    head_sha: revision.head.sha,
    external_id: externalId,
    details_url: url,
    status: result ? 'completed' : 'in_progress',
    ...(result ? { conclusion: result.conclusion } : {}),
    output: {
      title: result
        ? result.conclusion === 'success'
          ? 'AIレビューと投稿が完了しました'
          : `AIレビュー: ${result.reason} (${result.target})`
        : 'AIレビュー実行中',
      summary: result
        ? `対象: ${result.target}、理由: ${result.reason}。\n\n[AIレビューの実行ログ](${url})\n\n成功はレビュー処理と投稿の完了を表します。指摘の解決・Resolveは人間が判断します。`
        : `資料収集・レビュー生成・コメント投稿の実行状態を確認しています。\n\n[AIレビューの実行ログ](${url})`,
    },
  };
  if (check) {
    const { head_sha: reviewedHead, ...update } = body;
    // 更新APIではhead_shaを受け付けない。登録済みSHAの照合は上で完了している。
    if (reviewedHead !== check.head_sha) throw new Error('チェックの対象が不一致です');
    await api(`check-runs/${check.id}`, 'PATCH', update);
  } else await api('check-runs', 'POST', body);
}
if (import.meta.main) {
  try {
    await updateReviewCheck(
      githubApi<CheckRequest>(process.env.GH_TOKEN ?? ''),
      Number(process.env.REVIEW_RUN_ID),
      Number(process.env.REVIEW_RUN_ATTEMPT),
      process.env.REVIEW_RUN_PHASE ?? '',
      process.env.REVIEW_REPORT_DOWNLOAD === 'success'
        ? process.env.REVIEW_REPORT_DIRECTORY
        : undefined,
    );
  } catch {
    console.error('AIレビューのチェック通知に失敗しました。実行元・権限・接続を確認してください。');
    process.exitCode = 1;
  }
}
