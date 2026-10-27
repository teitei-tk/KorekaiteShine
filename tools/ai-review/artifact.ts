import { validBudget } from './budget.ts';
import type { BudgetRecord } from './budget.ts';
import { readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './source-index.ts';
import { validatePlan } from './partition.ts';
import type { ReviewPlan } from './partition.ts';
import type { PartitionResult } from './partition-review.ts';
import { validReview } from './policy.ts';
import type { ReviewInput } from './policy.ts';

export interface GenerationOrigin {
  run: string;
  attempt: string;
  sha: string;
}
interface ExecutionRecord {
  version: 1 | 2;
  budget?: BudgetRecord;
  budgetHash?: string;
  origin: GenerationOrigin;
  planHash: string;
  metadataHash: string;
  resultHash: string;
  completed: string[];
  calls: number;
  inputBytes: number;
  usage: PartitionResult['usage'];
}
export function readArtifactText(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error('成果物の容量が不正です');
  return readFileSync(path, 'utf8');
}
function validOrigin(origin: GenerationOrigin): boolean {
  return (
    !!origin &&
    /^[1-9]\d*$/.test(origin.run) &&
    /^[1-9]\d*$/.test(origin.attempt) &&
    /^[a-f0-9]{40}$/.test(origin.sha)
  );
}
export function writePartitionArtifact(
  directory: string,
  plan: ReviewPlan,
  result: PartitionResult,
  origin: GenerationOrigin,
): void {
  if (!validOrigin(origin)) throw new Error('生成元が不正です');
  const planText = readArtifactText(join(directory, 'plan.json'));
  const metadataText = readArtifactText(join(directory, 'metadata.json'));
  if (JSON.stringify(plan) !== planText || JSON.stringify(plan.metadata) !== metadataText)
    throw new Error('生成中に入力が変わりました');
  const resultText = JSON.stringify(result.review);
  const budgetPath = join(directory, 'budget.json');
  const budget: BudgetRecord | undefined = existsSync(budgetPath)
    ? JSON.parse(readArtifactText(budgetPath))
    : undefined;
  const record: ExecutionRecord = {
    version: budget ? 2 : 1,
    ...(budget ? { budget, budgetHash: digest(JSON.stringify(budget)) } : {}),
    origin,
    planHash: digest(planText),
    metadataHash: digest(metadataText),
    resultHash: digest(resultText),
    completed: result.completed,
    calls: result.calls,
    inputBytes: result.inputBytes,
    usage: budget ? budgetUsage(budget) : result.usage,
  };
  writeFileSync(join(directory, 'result.json'), resultText);
  writeFileSync(join(directory, 'execution.json'), JSON.stringify(record));
  verifyPartitionArtifact(directory, origin);
}
export function verifyPartitionArtifact(directory: string, expected: GenerationOrigin): void {
  const record = JSON.parse(readArtifactText(join(directory, 'execution.json'))) as ExecutionRecord;
  const planText = readArtifactText(join(directory, 'plan.json'));
  const metadataText = readArtifactText(join(directory, 'metadata.json'));
  const resultText = readArtifactText(join(directory, 'result.json'));
  if (
    !record ||
    ![1, 2].includes(record.version) ||
    !validOrigin(expected) ||
    !validOrigin(record.origin) ||
    record.origin.run !== expected.run ||
    record.origin.attempt !== expected.attempt ||
    record.origin.sha !== expected.sha ||
    digest(planText) !== record.planHash ||
    digest(metadataText) !== record.metadataHash ||
    digest(resultText) !== record.resultHash
  )
    throw new Error('成果物の生成元またはハッシュが一致しません');
  const plan: ReviewPlan = validatePlan(JSON.parse(planText));
  if (
    JSON.stringify(plan.metadata) !== metadataText ||
    plan.metadata.partitionVersion !== 1 ||
    !Array.isArray(record.completed) ||
    JSON.stringify(record.completed) !== JSON.stringify(plan.tasks.map((t) => t.id)) ||
    !Number.isSafeInteger(record.calls) ||
    record.calls < plan.tasks.length ||
    !Number.isInteger(record.inputBytes) ||
    record.inputBytes < 1 ||
    !record.usage ||
    !Number.isInteger(record.usage.output) ||
    record.usage.output < 0 ||
    (record.version === 1 && record.usage.output > record.calls * 8000)
  )
    throw new Error('成果物の完了範囲が不正です');
  if (record.version === 2) {
    const budget = record.budget;
    if (
      !budget ||
      !validBudget(budget) ||
      budget.denied ||
      budget.entries.some((e) => e.actual === null) ||
      digest(JSON.stringify(budget)) !== record.budgetHash ||
      JSON.stringify(budget.origin) !== JSON.stringify(record.origin) ||
      budget.target.number !== plan.metadata.number ||
      budget.target.head !== plan.metadata.head ||
      budget.target.base !== plan.metadata.base ||
      JSON.stringify(budgetUsage(budget)) !== JSON.stringify(record.usage) ||
      budget.entries.length < plan.tasks.length ||
      budget.entries.length > record.calls
    )
      throw new Error('成果物の課金記録が一致しません');
  }
  const review = validReview(
    JSON.parse(resultText) as ReviewInput,
    plan.metadata.lines,
    plan.metadata.priorFindings,
  );
  if (review.status !== 'complete') throw new Error('未完了の結果は投稿できません');
}

export function budgetUsage(record: BudgetRecord): PartitionResult['usage'] {
  if (!validBudget(record) || record.entries.some((e) => !e.usage))
    throw new Error('未精算の課金記録です');
  return record.entries.reduce(
    (sum, e) => ({
      input: sum.input + e.usage!.input,
      output: sum.output + e.usage!.output,
      total: sum.total + e.usage!.total,
    }),
    { input: 0, output: 0, total: 0 },
  );
}
