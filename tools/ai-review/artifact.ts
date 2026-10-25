import { readFileSync, statSync, writeFileSync } from 'node:fs';
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
  version: 1;
  origin: GenerationOrigin;
  planHash: string;
  metadataHash: string;
  resultHash: string;
  completed: string[];
  calls: number;
  inputBytes: number;
  usage: PartitionResult['usage'];
}
export function readBounded(path: string, max: number): string {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > max) throw new Error('成果物の容量が不正です');
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
  const planText = readBounded(join(directory, 'plan.json'), 6_000_000);
  const metadataText = readBounded(join(directory, 'metadata.json'), 400_000);
  if (JSON.stringify(plan) !== planText || JSON.stringify(plan.metadata) !== metadataText)
    throw new Error('生成中に入力が変わりました');
  const resultText = JSON.stringify(result.review);
  if (Buffer.byteLength(resultText) > 100_000) throw new Error('最終結果の容量を超えました');
  const record: ExecutionRecord = {
    version: 1,
    origin,
    planHash: digest(planText),
    metadataHash: digest(metadataText),
    resultHash: digest(resultText),
    completed: result.completed,
    calls: result.calls,
    inputBytes: result.inputBytes,
    usage: result.usage,
  };
  writeFileSync(join(directory, 'result.json'), resultText);
  writeFileSync(join(directory, 'execution.json'), JSON.stringify(record));
  verifyPartitionArtifact(directory, origin);
}
export function verifyPartitionArtifact(directory: string, expected: GenerationOrigin): void {
  const record = JSON.parse(
    readBounded(join(directory, 'execution.json'), 30_000),
  ) as ExecutionRecord;
  const planText = readBounded(join(directory, 'plan.json'), 6_000_000);
  const metadataText = readBounded(join(directory, 'metadata.json'), 400_000);
  const resultText = readBounded(join(directory, 'result.json'), 100_000);
  if (
    !record ||
    record.version !== 1 ||
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
    record.inputBytes > record.calls * 500_000 ||
    !record.usage ||
    !Number.isInteger(record.usage.output) ||
    record.usage.output < 0 ||
    record.usage.output > record.calls * 8000
  )
    throw new Error('成果物の完了範囲が不正です');
  const review = validReview(
    JSON.parse(resultText) as ReviewInput,
    plan.metadata.lines,
    plan.metadata.priorFindings,
  );
  if (review.status !== 'complete') throw new Error('未完了の結果は投稿できません');
}
