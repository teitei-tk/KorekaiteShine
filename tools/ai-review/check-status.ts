import type { Api as GitHubApi } from './github.ts';
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
interface Outcome {
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out';
  target: string;
  reason: StatusReason;
}
export async function completedOutcome(
  api: GitHubApi,
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
