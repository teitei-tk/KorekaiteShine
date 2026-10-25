import { writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { failureReasons } from './failure.ts';

const reasons = [
  ...failureReasons,
  'PUBLISH_FAILED',
  'EXECUTION_FAILED',
  'TARGET_CHANGED',
  'SKIPPED',
  'REVIEW_COMPLETE',
  'ALREADY_COMPLETE',
  'CANCELLED',
  'TIMED_OUT',
  'SUPERSEDED',
  'REPORT_INVALID',
  'REPORT_MISSING',
] as const;
export type StatusReason = (typeof reasons)[number];
export type ReportJob = 'gate' | 'generate' | 'publish';
export interface StatusReport {
  version: 1;
  run: string;
  attempt: string;
  job: ReportJob;
  status: 'success' | 'failure' | 'neutral';
  target: string;
  reason: StatusReason;
}
export function validTarget(value: string): boolean {
  return (
    typeof value === 'string' &&
    /^(gate|history|collect|preflight|artifact|publish|generate|workflow|invalid-task-id|(?:task|reconcile)-[1-9]\d{0,5})$/.test(
      value,
    )
  );
}
export function validReport(value: Partial<StatusReport> | null): value is StatusReport {
  return (
    !!value &&
    value.version === 1 &&
    typeof value.run === 'string' &&
    /^[1-9]\d{0,17}$/.test(value.run) &&
    typeof value.attempt === 'string' &&
    /^[1-9]\d{0,5}$/.test(value.attempt) &&
    ['gate', 'generate', 'publish'].includes(value.job ?? '') &&
    ['success', 'failure', 'neutral'].includes(value.status ?? '') &&
    validTarget(value.target ?? '') &&
    reasons.some((reason) => reason === value.reason) &&
    (value.status !== 'success' ||
      (value.job === 'publish' &&
        value.target === 'publish' &&
        ['REVIEW_COMPLETE', 'ALREADY_COMPLETE'].includes(value.reason ?? '')) ||
      (['gate', 'generate'].includes(value.job ?? '') &&
        value.target === 'gate' &&
        value.reason === 'ALREADY_COMPLETE')) &&
    (value.status !== 'neutral' || ['TARGET_CHANGED', 'SKIPPED'].includes(value.reason ?? '')) &&
    (value.status !== 'failure' ||
      !['REVIEW_COMPLETE', 'ALREADY_COMPLETE', 'TARGET_CHANGED', 'SKIPPED'].includes(
        value.reason ?? '',
      ))
  );
}
export function writeStatusReport(
  env: Record<string, string | undefined>,
  status: StatusReport['status'],
  target: string,
  reason: StatusReason,
): void {
  const path =
    env.AI_REVIEW_REPORT ??
    (env.RUNNER_TEMP && env.AI_REVIEW_JOB ? join(env.RUNNER_TEMP, 'status.json') : undefined);
  if (!path) return;
  const value = {
    version: 1,
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    job: env.AI_REVIEW_JOB,
    status,
    target,
    reason,
  };
  if (!validReport(value as Partial<StatusReport>)) throw new Error('実行結果の形式が不正です');
  writeFileSync(path, JSON.stringify(value));
}
export function readStatusReports(
  directory: string | undefined,
  run: number,
  attempt: number,
): StatusReport[] {
  if (!directory) return [];
  const reports: StatusReport[] = [];
  const readReport = (path: string, job?: ReportJob): StatusReport => {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 4096) throw new Error('実行結果が大きすぎます');
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<StatusReport> | null;
    if (
      !validReport(value) ||
      value.run !== String(run) ||
      value.attempt !== String(attempt) ||
      (job !== undefined && value.job !== job)
    )
      throw new Error('実行結果の生成元が不正です');
    return value;
  };
  for (const job of ['gate', 'generate', 'publish'] as const) {
    const path = join(directory, `ai-review-status-${run}-${attempt}-${job}`, 'status.json');
    if (!existsSync(path)) continue;
    reports.push(readReport(path, job));
  }
  // download-artifact v8は取得対象が1件なら指定先の直下へ展開する。
  const single = join(directory, 'status.json');
  if (existsSync(single)) {
    if (reports.length) throw new Error('単一・複数Artifactの展開結果が混在しています');
    reports.push(readReport(single));
  }
  return reports;
}
