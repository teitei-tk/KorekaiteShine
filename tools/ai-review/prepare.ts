import { reviewHistory } from './history.ts';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { githubApi, target, comments, reviewComments } from './github.ts';
import type { Api } from './github.ts';
import { join } from 'node:path';
import { preflight } from './partition-review.ts';
import { collect } from './material.ts';
import { ReviewFailure } from './failure.ts';
import type { FailureReason } from './failure.ts';
import { writeStatusReport } from './status-report.ts';

export async function prepareReview(
  mode: string,
  env: Record<string, string | undefined>,
  api?: Api,
  collectMaterial: typeof collect = collect,
): Promise<void> {
  let targetId = 'gate';
  let fallback: FailureReason = 'TARGET_FAILED';
  try {
    if (!api && !env.GH_TOKEN) throw new ReviewFailure('AUTH_FAILED', 'GitHub認証がありません');
    const client = api ?? githubApi(env.GH_TOKEN!);
    const result = await target(client, Number(env.SOURCE_RUN_ID));
    if (result.status !== 'ready') {
      writeStatusReport(
        env,
        result.status === 'already-complete' ? 'success' : 'neutral',
        'gate',
        result.status === 'already-complete' ? 'ALREADY_COMPLETE' : 'SKIPPED',
      );
      appendFileSync(env.GITHUB_OUTPUT!, 'allowed=false\n');
      return;
    }
    const pr = result.pr;
    if (mode === 'collect' && env.AI_REVIEW_MODE === 'review') {
      targetId = 'collect';
      fallback = 'INPUT_INVALID';
      const directory = env.REVIEW_DIRECTORY;
      if (!directory) throw new Error('資料ディレクトリがありません');
      mkdirSync(directory, { recursive: true });
      targetId = 'history';
      fallback = 'HISTORY_FAILED';
      const [legacy, inline] = await Promise.all([
        comments(client, pr.number),
        reviewComments(client, pr.number),
      ]);
      const history = reviewHistory(legacy, inline, pr.head.sha, pr.base.sha);
      targetId = 'collect';
      fallback = 'COLLECTION_FAILED';
      collectMaterial(pr, directory, history);
      targetId = 'preflight';
      fallback = 'INPUT_INVALID';
      preflight(JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')));
    }
    appendFileSync(
      env.GITHUB_OUTPUT!,
      `allowed=true\npr=${pr.number}\nhead=${pr.head.sha}\nbase=${pr.base.sha}\n`,
    );
  } catch (error) {
    // 外部API・gitのメッセージでは分類せず、信頼済み処理の固定コードだけを表示する。
    const reason = error instanceof ReviewFailure ? error.reason : fallback;
    writeStatusReport(env, 'failure', targetId, reason);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, 'allowed=false\n');
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `AIレビュー準備未完了: 完了0件。対象: ${targetId}、理由: ${reason}。WIF認証・レビュー生成・投稿へ進みません。\n`,
      );
    throw new ReviewFailure(
      reason,
      `AIレビュー準備が未完了です。対象: ${targetId}、理由: ${reason}。`,
    );
  }
}

if (import.meta.main) {
  try {
    await prepareReview(process.argv[2] ?? '', process.env);
  } catch (error) {
    console.error(
      error instanceof ReviewFailure ? error.message : 'AIレビュー準備の記録に失敗しました。',
    );
    process.exitCode = 1;
  }
}
