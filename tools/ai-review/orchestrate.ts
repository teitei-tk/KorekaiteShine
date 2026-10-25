import { ReviewFailure, validFailureReason } from './failure.ts';
import type { FailureReason } from './failure.ts';
import { execFile } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { authenticate } from './wif.ts';
import { preflight, runPartitionReview } from './partition-review.ts';
import type { TaskInvocation, TaskResult } from './partition-review.ts';
import type { ReviewResult } from './review.ts';
import { readBounded, writePartitionArtifact } from './artifact.ts';
import type { ReviewPlan } from './partition.ts';
import { writeStatusReport } from './status-report.ts';

export function workerEnvironment(token: string): Record<string, string> {
  return { OPENAI_ACCESS_TOKEN: token };
}
async function callWorker(
  input: TaskInvocation,
  token: string,
  plan: ReviewPlan,
): Promise<ReviewResult<TaskResult>> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [fileURLToPath(new URL('./review-worker.ts', import.meta.url))],
      { env: workerEnvironment(token), timeout: 170_000, maxBuffer: 150_000 },
      (error, stdout) => {
        if (error) {
          reject(new Error('モデル子プロセスが失敗しました'));
          return;
        }
        try {
          const result = JSON.parse(stdout) as ReviewResult<TaskResult> & { failure?: string };
          if (validFailureReason(result.failure))
            reject(new ReviewFailure(result.failure, 'モデル子プロセスが未完了です'));
          else resolve(result);
        } catch {
          reject(new Error('モデル出力が不正です'));
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ input, plan }));
  });
}
export async function generatePartitionArtifact(
  directory: string,
  env: Record<string, string | undefined>,
  request: typeof fetch = fetch,
  worker: (
    input: TaskInvocation,
    token: string,
    plan: ReviewPlan,
  ) => Promise<ReviewResult<TaskResult>> = callWorker,
  mask: (secret: string) => void = () => {},
): Promise<void> {
  // 前回の部分生成物を完了成果物として使わない。
  for (const path of ['result.json', 'execution.json'])
    rmSync(join(directory, path), { force: true });
  let completed = 0;
  let total = 0;
  let target = 'preflight';
  let fallback: FailureReason = 'INPUT_INVALID';
  try {
    const plan = JSON.parse(readBounded(join(directory, 'plan.json'), 6_000_000)) as ReviewPlan;
    if (JSON.stringify(plan.metadata) !== readBounded(join(directory, 'metadata.json'), 400_000))
      throw new Error('入力の対象情報が一致しません');
    total = Array.isArray(plan?.tasks) ? plan.tasks.length : 0;
    preflight(plan);
    const result = await runPartitionReview(
      plan,
      async (input) => {
        fallback = 'AUTH_FAILED';
        const auth = await authenticate(env, 'review', request, mask);
        if (!auth.accessToken) throw new Error('WIFトークンがありません');
        fallback = 'MODEL_FAILED';
        const response = await worker(input, auth.accessToken, plan);
        fallback = 'OUTPUT_INVALID';
        return response;
      },
      (count) => {
        completed = count;
      },
      (task) => {
        target = /^(task|reconcile)-[1-9]\d*$/.test(task.id) ? task.id : 'invalid-task-id';
        fallback = 'OUTPUT_INVALID';
      },
    );
    target = 'artifact';
    fallback = 'ARTIFACT_INVALID';
    writePartitionArtifact(directory, plan, result, {
      run: env.GITHUB_RUN_ID ?? '',
      attempt: env.GITHUB_RUN_ATTEMPT ?? '',
      sha: env.GITHUB_SHA ?? '',
    });
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `分割レビュー完了: ${completed}/${plan.tasks.length}作業、${result.calls}回、input=${result.usage.input} / output=${result.usage.output} tokens。\n`,
      );
    if (env.GITHUB_OUTPUT)
      appendFileSync(
        env.GITHUB_OUTPUT,
        `artifact=ai-review-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}\nattempt=${env.GITHUB_RUN_ATTEMPT}\n`,
      );
  } catch (error) {
    const reason = error instanceof ReviewFailure ? error.reason : fallback;
    writeStatusReport(env, 'failure', target, reason);
    for (const path of ['result.json', 'execution.json'])
      rmSync(join(directory, path), { force: true });
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `分割レビュー未完了: ${completed}/${total}作業完了。対象: ${target}、理由: ${reason}。残る必須作業・候補整理は未完了です。部分結果は投稿しません。\n`,
      );
    throw new Error('分割レビューが未完了です');
  }
}
if (import.meta.main) {
  try {
    await generatePartitionArtifact(
      process.env.REVIEW_DIRECTORY!,
      process.env,
      fetch,
      callWorker,
      (secret) =>
        console.log(
          `::add-mask::${secret.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`,
        ),
    );
  } catch {
    console.error('分割レビューが未完了です。資料・認証・モデル・出力の検証を確認してください。');
    process.exitCode = 1;
  }
}
