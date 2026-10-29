import { readInlineHistory } from './history.ts';
import { loadSnapshot } from './snapshot.ts';
import { appendFileSync, mkdirSync } from 'node:fs';
import { githubApi, target, ownComment } from './github.ts';
import type { Api } from './github.ts';
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
      const history = await loadSnapshot(client, pr.number);
      if (
        readInlineHistory(history.inline).some(
          (f) => f.head === pr.head.sha && f.base === pr.base.sha,
        ) ||
        [...history.issues, ...history.inline].some(
          (c) =>
            ownComment(c) &&
            /<!-- generation:v2:\d+:\d+:/.test(c.body) &&
            c.body.includes(`:${pr.head.sha}:${pr.base.sha} -->`),
        )
      )
        throw new Error('途中投稿があります。同じArtifactで投稿を再開してください');
      targetId = 'collect';
      fallback = 'COLLECTION_FAILED';
      collectMaterial(pr, directory, history, env.SOURCE_RUN_ID!);
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
