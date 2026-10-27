import { renderCoverage } from './coverage-diagnostic.ts';
import { failureMessage } from './failure-message.ts';
import { appendFileSync } from 'node:fs';
import { completedOutcome } from './check-status.ts';
import type { ReviewRun } from './check-status.ts';
import { comments, githubApi, target } from './github.ts';
import type { Api, Comment, Run } from './github.ts';
import { eligible, REPOSITORY, REPOSITORY_ID } from './policy.ts';
import type { PullRequest } from './policy.ts';

interface NotificationRun extends ReviewRun {
  head_branch: string;
}
interface SourceRun extends Run {
  id: number;
  run_attempt: number;
}
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
export async function failureTarget(api: Api, id: number, attempt: number) {
  if (!positive(id) || !positive(attempt)) throw new Error('通知対象の実行IDが不正です');
  // 最新試行だけを扱い、旧試行の遅延通知を防ぐ。
  const run = await api<NotificationRun>(`actions/runs/${id}`);
  if (
    !run ||
    run.id !== id ||
    run.run_attempt !== attempt ||
    run.status !== 'completed' ||
    run.event !== 'workflow_run' ||
    run.path !== '.github/workflows/ai-review.yml' ||
    run.head_branch !== 'main' ||
    run.repository?.id !== REPOSITORY_ID ||
    run.head_repository?.id !== REPOSITORY_ID
  )
    return;
  const match =
    typeof run.display_title === 'string'
      ? /^AI review \/ source run ([1-9]\d{0,17}) attempt ([1-9]\d{0,5}) \/ review$/.exec(
          run.display_title,
        )
      : null;
  if (!match) return;
  const sourceId = Number(match[1]),
    sourceAttempt = Number(match[2]);
  if (!positive(sourceId) || !positive(sourceAttempt)) return;
  const source = await api<SourceRun>(`actions/runs/${sourceId}`);
  if (source?.id !== sourceId || source.run_attempt !== sourceAttempt) return;
  // 元CIのWorkflow・リポジトリ・本人PR・現在のhead/base・merge親を再検証する。
  const accepted = await target(api, sourceId);
  if (accepted.status === 'excluded') return;
  return { run, pr: accepted.pr };
}
type NotificationResult = { status: 'skipped' } | { status: 'notified'; commentId: number };
export async function notifyFailure(
  api: Api,
  id: number,
  attempt: number,
  directory?: string,
): Promise<NotificationResult> {
  const accepted = await failureTarget(api, id, attempt);
  if (!accepted || accepted.run.conclusion === 'success') return { status: 'skipped' };
  const outcome = await completedOutcome(api, accepted.run, directory);
  if (outcome.conclusion === 'success' || outcome.conclusion === 'neutral')
    return { status: 'skipped' };
  const { number } = accepted.pr;
  const head = accepted.pr.head.sha,
    base = accepted.pr.base.sha;
  const marker = `<!-- ai-review-failure:${id}:${attempt}:${number}:${head}:${base} -->`;
  // 表示するのは検証済み固定分類・ID・SHAだけ。外部エラー本文やモデル出力は使わない。
  const body = [
    marker,
    '### AIレビューを完了できませんでした',
    failureMessage(outcome.reason, outcome.diagnostic?.subcode),
    ...(outcome.diagnostic?.coverage ? [renderCoverage(outcome.diagnostic.coverage)] : []),
    '**レビュー全体は未完了です。** 既に投稿された指摘・返信はそのまま残ります。',
    `[実行記録を確認](https://github.com/${REPOSITORY}/actions/runs/${id}/attempts/${attempt})`,
    '<details>\n<summary>調査用の詳細</summary>\n',
    `段階: ${outcome.target}。失敗理由: ${outcome.reason}${outcome.diagnostic ? ' / ' + outcome.diagnostic.subcode : ''}。`,
    `対象: ${head} / base: ${base}`,
    '</details>',
  ].join('\n\n');
  const prior = (await comments(api, number)).filter(
    (c) =>
      c.user?.id === 41898282 &&
      c.user.login === 'github-actions[bot]' &&
      c.user.type === 'Bot' &&
      typeof c.body === 'string' &&
      c.body.includes(marker),
  );
  // Artifactの保存期間後の再通知でも、同じ実行の通知は重複させない。
  if (prior.length > 1) throw new Error('失敗通知が重複しています');
  const current = await failureTarget(api, id, attempt);
  if (
    !current ||
    current.pr.number !== number ||
    current.pr.head.sha !== head ||
    current.pr.base.sha !== base
  )
    return { status: 'skipped' };
  // 投稿直前にも、開始時に固定した対象と照合する。
  const latest = await api<PullRequest>(`pulls/${number}`);
  if (
    !eligible(latest) ||
    latest.number !== number ||
    latest.head.sha !== head ||
    latest.base.sha !== base
  )
    return { status: 'skipped' };
  const posted = prior[0] ?? (await api<Comment>(`issues/${number}/comments`, 'POST', { body }));
  if (!positive(posted.id)) throw new Error('通知結果が不正です');
  return { status: 'notified', commentId: posted.id };
}
if (import.meta.main) {
  try {
    const api = githubApi(process.env.GH_TOKEN ?? '');
    const id = Number(process.env.REVIEW_RUN_ID),
      attempt = Number(process.env.REVIEW_RUN_ATTEMPT);
    if (process.argv[2] === 'prepare') {
      const accepted = await failureTarget(api, id, attempt);
      if (!process.env.GITHUB_OUTPUT) throw new Error('出力先がありません');
      appendFileSync(process.env.GITHUB_OUTPUT, `allowed=${accepted ? 'true' : 'false'}\n`);
    } else if (process.argv[2] === 'publish') {
      const result = await notifyFailure(
        api,
        id,
        attempt,
        process.env.REVIEW_REPORT_DOWNLOAD === 'success'
          ? process.env.REVIEW_REPORT_DIRECTORY
          : undefined,
      );
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          result.status === 'notified'
            ? `AIレビュー失敗通知を投稿済み（comment ID: ${result.commentId}）。元レビューは未完了です。\n`
            : '対象外または通知不要のため投稿しませんでした。\n',
        );
    } else throw new Error('通知操作が不正です');
  } catch {
    console.error(
      '::error::FAILURE_NOTIFICATION_FAILED: AIレビューの失敗通知を完了できませんでした。',
    );
    process.exitCode = 1;
  }
}
