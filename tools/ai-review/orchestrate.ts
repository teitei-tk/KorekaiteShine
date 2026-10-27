import { withReviewDeadline, REVIEW_TIME_MS, timeFailure } from './deadline.ts';
import { ReviewFailure, validFailureReason, workerFailure } from './failure.ts';
import type { FailureReason } from './failure.ts';
import { detail, validDetail, taskScope, renderDiagnostic } from './diagnostics.ts';
import type { DetailInput, Diagnostic, TaskScope } from './diagnostics.ts';
import { fork } from 'node:child_process';
import { BudgetLedger, spent, LIMIT } from './budget.ts';
import type { BillingUsage } from './budget.ts';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { authenticate } from './wif.ts';
import { preflight, runPartitionReview } from './partition-review.ts';
import type { TaskInvocation, TaskResult } from './partition-review.ts';
import type { ReviewResult } from './review.ts';
import { readArtifactText, writePartitionArtifact } from './artifact.ts';
import type { ReviewPlan } from './partition.ts';
import { writeStatusReport } from './status-report.ts';

export function workerEnvironment(token: string): Record<string, string> {
  return { OPENAI_ACCESS_TOKEN: token };
}
export async function callWorker(
  input: TaskInvocation,
  token: string,
  plan: ReviewPlan,
  budget: BudgetLedger,
  signal?: AbortSignal,
): Promise<ReviewResult<TaskResult>> {
  if (signal?.aborted) throw timeFailure();
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./review-worker.ts', import.meta.url)), [], {
      env: workerEnvironment(token),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
    });
    let done = false,
      reserved = false,
      settled = false;
    const finish = (error?: Error, result?: ReviewResult<TaskResult>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('モデル子プロセスが時間切れです')), 200000);
    const abort = () => finish(timeFailure());
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new Error('モデル子プロセスが失敗しました')));
    child.on('exit', () => finish(new Error('モデル子プロセスが終了しました')));
    child.on(
      'message',
      (message: {
        kind?: string;
        input?: number;
        hash?: string;
        usage?: BillingUsage;
        result?: ReviewResult<TaskResult>;
      }) => {
        if (done) return;
        try {
          if (!message) throw new Error('IPC形式不正');
          if (message.kind === 'reserve' && !reserved) {
            budget.reserve(message.input!, message.hash!);
            reserved = true;
            child.send({ approved: true });
          } else if (message.kind === 'settle' && reserved && !settled) {
            budget.settle(message.usage!);
            settled = true;
            child.send({ approved: true });
          } else if (message.kind === 'result') {
            const result = decodeWorkerResult(JSON.stringify(message.result));
            if (!settled) throw new ReviewFailure('USAGE_INVALID', '費用が未精算です');
            finish(undefined, result);
          } else throw new Error('IPC順序不正');
        } catch (error) {
          finish(
            error instanceof ReviewFailure
              ? error
              : new ReviewFailure('OUTPUT_INVALID', 'モデル子プロセスの形式が不正です'),
          );
        }
      },
    );
    child.send({ input, plan }, (error) => {
      if (error) finish(new Error('モデル入力を渡せません'));
    });
  });
}
export function decodeWorkerResult(stdout: string): ReviewResult<TaskResult> {
  let result: ReviewResult<TaskResult> & { failure?: string; detail?: DetailInput };
  try {
    result = JSON.parse(stdout) as typeof result;
  } catch {
    throw new ReviewFailure('OUTPUT_INVALID', 'モデル出力が不正です', detail('INVALID_JSON'));
  }
  if (!result || typeof result !== 'object')
    throw new ReviewFailure('OUTPUT_INVALID', 'モデル出力が不正です', detail('INVALID_RESULT'));
  if (result.failure !== undefined) {
    if (!validFailureReason(result.failure))
      throw new ReviewFailure('OUTPUT_INVALID', '失敗コードが不正です', detail('INVALID_RESULT'));
    if (result.detail !== undefined && !validDetail(result.detail))
      throw new ReviewFailure('OUTPUT_INVALID', '診断分類が不正です', detail('INVALID_DIAGNOSTIC'));
    throw new ReviewFailure(
      result.failure,
      'モデル子プロセスが未完了です',
      result.detail
        ? detail(result.detail.subcode, result.detail.missing, result.detail.coverage)
        : undefined,
    );
  }
  return result;
}
export async function generatePartitionArtifact(
  directory: string,
  env: Record<string, string | undefined>,
  request: typeof fetch = fetch,
  worker: (
    input: TaskInvocation,
    token: string,
    plan: ReviewPlan,
    budget: BudgetLedger,
    signal?: AbortSignal,
  ) => Promise<ReviewResult<TaskResult>> = callWorker,
  mask: (secret: string) => void = () => {},
  budgetLimit = LIMIT,
  timeLimitMs = REVIEW_TIME_MS,
): Promise<void> {
  // 前回の部分生成物を完了成果物として使わない。
  for (const path of ['result.json', 'execution.json', 'budget-result.json', 'budget.json'])
    rmSync(join(directory, path), { force: true });
  let budget: BudgetLedger | undefined;
  let scope: TaskScope | undefined;
  let completed = 0;
  let total = 0;
  let target = 'preflight';
  let fallback: FailureReason = 'INPUT_INVALID';
  try {
    const plan = JSON.parse(readArtifactText(join(directory, 'plan.json'))) as ReviewPlan;
    if (JSON.stringify(plan.metadata) !== readArtifactText(join(directory, 'metadata.json')))
      throw new Error('入力の対象情報が一致しません');
    total = Array.isArray(plan?.tasks) ? plan.tasks.length : 0;
    const result = await withReviewDeadline(async (signal, checkTime) => {
      preflight(plan);
      budget = new BudgetLedger(
        join(directory, 'budget.json'),
        {
          run: env.GITHUB_RUN_ID ?? '',
          attempt: env.GITHUB_RUN_ATTEMPT ?? '',
          sha: env.GITHUB_SHA ?? '',
        },
        { number: plan.metadata.number, head: plan.metadata.head, base: plan.metadata.base },
        budgetLimit,
      );
      return await runPartitionReview(
        plan,
        async (input) => {
          fallback = 'AUTH_FAILED';
          checkTime();
          const boundedRequest: typeof fetch = (url, init) => {
            checkTime();
            return request(url, {
              ...init,
              signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
            });
          };
          const auth = await authenticate(env, 'review', boundedRequest, mask);
          checkTime();
          if (!auth.accessToken) throw new Error('WIFトークンがありません');
          fallback = 'MODEL_FAILED';
          const response = await worker(input, auth.accessToken, plan, budget!, signal);
          fallback = 'OUTPUT_INVALID';
          return response;
        },
        (count) => {
          completed = count;
        },
        (task) => {
          target = /^(task|reconcile)-[1-9]\d*$/.test(task.id) ? task.id : 'invalid-task-id';
          scope = taskScope(plan, task);
          fallback = 'OUTPUT_INVALID';
        },
        checkTime,
      );
    }, timeLimitMs);
    target = 'artifact';
    scope = undefined;
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
    if (error instanceof ReviewFailure && error.reason === 'COST_BUDGET_EXCEEDED' && budget) {
      const record = budget.snapshot();
      if (record.denied || spent(record) > record.limit) {
        writeFileSync(join(directory, 'budget-result.json'), JSON.stringify(record));
        writeStatusReport(env, 'neutral', target, 'COST_BUDGET_EXCEEDED');
        if (env.GITHUB_STEP_SUMMARY)
          appendFileSync(
            env.GITHUB_STEP_SUMMARY,
            '予算不足のためレビュー未完了です。PR通知を投稿ジョブへ引き渡します。\n',
          );
        if (env.GITHUB_OUTPUT)
          appendFileSync(
            env.GITHUB_OUTPUT,
            `artifact=ai-review-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}\nattempt=${env.GITHUB_RUN_ATTEMPT}\n`,
          );
        return;
      }
    }
    const reason = error instanceof ReviewFailure ? error.reason : fallback;
    const safeDetail =
      workerFailure(error instanceof ReviewFailure ? error : undefined).detail ??
      detail('UNCLASSIFIED');
    const diagnostic: Diagnostic = { ...safeDetail, ...(scope ? { scope } : {}) };
    writeStatusReport(env, 'failure', target, reason, diagnostic);
    for (const path of ['result.json', 'execution.json'])
      rmSync(join(directory, path), { force: true });
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `分割レビュー未完了: ${completed}/${total}作業完了。対象: ${target}、理由: ${reason}。残る必須作業・候補整理は未完了です。部分結果は投稿しません。\n\n${renderDiagnostic(diagnostic)}\n`,
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
