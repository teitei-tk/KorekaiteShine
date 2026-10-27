import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { validBudget, spent, LIMIT } from './budget.ts';
import type { BudgetRecord, BudgetTarget } from './budget.ts';
import { readArtifactText } from './artifact.ts';
import type { GenerationOrigin } from './artifact.ts';
import { comments } from './github.ts';
import type { Api, Comment } from './github.ts';
import { eligible, REPOSITORY } from './policy.ts';
import type { PullRequest } from './policy.ts';
import { writeStatusReport } from './status-report.ts';
const overBudget = (r: BudgetRecord) => validBudget(r) && (!!r.denied || spent(r) > r.limit);
export function readBudgetArtifact(
  directory: string,
  target: BudgetTarget,
  origin: GenerationOrigin,
): BudgetRecord {
  const record = JSON.parse(
    readArtifactText(join(directory, 'budget-result.json')),
  ) as BudgetRecord;
  if (
    !overBudget(record) ||
    record.origin.run !== origin.run ||
    record.origin.attempt !== origin.attempt ||
    record.origin.sha !== origin.sha ||
    record.target.number !== target.number ||
    record.target.head !== target.head ||
    record.target.base !== target.base
  )
    throw new Error('予算成果物の対象または形式が不正です');
  return record;
}
function marker(r: BudgetRecord): string {
  return `<!-- ai-review-budget:${r.origin.run}:${r.origin.attempt}:${r.target.number}:${r.target.head}:${r.target.base} -->`;
}
export function renderBudget(r: BudgetRecord): string {
  if (!overBudget(r)) throw new Error('予算結果が不正です');
  const dollars = (n: number) => `$${(n / LIMIT).toFixed(6)}`;
  return [
    marker(r),
    spent(r) > r.limit
      ? '予算上限（$1）を超過したため、AIレビューを中止しました。PRを分割してください。'
      : '予算上限（$1）を超える見込みのため、AIレビューを中止しました。PRを分割してください。',
    '**AIレビューは未完了です。** 部分的な指摘・修正確認は投稿していません。',
    `使用済み費用: ${dollars(spent(r))}。${r.denied ? `次の呼び出しの最大費用: ${dollars(r.denied.maximum)}。` : ''}公表単価による算出額です。`,
    `対象: ${r.target.head} / base: ${r.target.base}`,
    `[実行記録](https://github.com/${REPOSITORY}/actions/runs/${r.origin.run}/attempts/${r.origin.attempt})`,
  ].join('\n\n');
}
export async function publishBudget(
  api: Api,
  record: BudgetRecord,
  env: Record<string, string | undefined>,
): Promise<void> {
  try {
    const body = renderBudget(record);
    const current = async () => {
      const pr = await api<PullRequest>(`pulls/${record.target.number}`);
      return (
        eligible(pr) &&
        pr.number === record.target.number &&
        pr.head.sha === record.target.head &&
        pr.base.sha === record.target.base
      );
    };
    if (!(await current())) {
      writeStatusReport(env, 'neutral', 'publish', 'TARGET_CHANGED');
      return;
    }
    const prior = (await comments(api, record.target.number)).filter(
      (c) =>
        c.user?.id === 41898282 &&
        c.user.login === 'github-actions[bot]' &&
        c.user.type === 'Bot' &&
        c.body.includes(marker(record)),
    );
    if (prior.length > 1 || prior.some((c) => c.body !== body))
      throw new Error('予算通知が一致しません');
    if (!(await current())) {
      writeStatusReport(env, 'neutral', 'publish', 'TARGET_CHANGED');
      return;
    }
    const posted =
      prior[0] ?? (await api<Comment>(`issues/${record.target.number}/comments`, 'POST', { body }));
    if (!Number.isSafeInteger(posted.id) || posted.id < 1) throw new Error('投稿結果が不正です');
    writeStatusReport(env, 'success', 'publish', 'BUDGET_NOTIFIED', undefined, posted.id);
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `予算不足・レビュー未完了・[PR通知済み](https://github.com/${REPOSITORY}/issues/${record.target.number}#issuecomment-${posted.id})。\n`,
      );
  } catch (error) {
    writeStatusReport(env, 'failure', 'publish', 'PUBLISH_FAILED');
    throw error;
  }
}
