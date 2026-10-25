import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completedOutcome } from './check-status.ts';
import type { ReviewRun } from './check-status.ts';
import type { Api } from './github.ts';

const run: ReviewRun = {
  id: 20,
  run_attempt: 1,
  event: 'workflow_run',
  path: '.github/workflows/ai-review.yml',
  display_title: 'AI review / source run 10 attempt 1 / review',
  status: 'completed',
  conclusion: 'success',
  repository: { id: 1426899426 },
  head_repository: { id: 1426899426 },
};
const api: Api = async <T>() => ({ jobs: [{ name: 'publish', conclusion: 'failure' }] }) as T;
async function report(value: object, work: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'review-outcome-'));
  writeFileSync(
    join(directory, 'status.json'),
    JSON.stringify({ version: 1, run: '20', attempt: '1', job: 'publish', ...value }),
  );
  try {
    await work(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
it('検証した投稿完了を成功にする', () =>
  report({ status: 'success', target: 'publish', reason: 'REVIEW_COMPLETE' }, async (directory) => {
    expect(await completedOutcome(api, run, directory)).toEqual({
      conclusion: 'success',
      target: 'publish',
      reason: 'REVIEW_COMPLETE',
    });
  }));
it('対象変更の記録を投稿完了と区別する', () =>
  report({ status: 'neutral', target: 'publish', reason: 'TARGET_CHANGED' }, async (directory) => {
    expect((await completedOutcome(api, run, directory)).conclusion).toBe('neutral');
  }));
it('収集・事前検証の対象IDと固定理由を保持する', () =>
  report(
    { job: 'generate', status: 'failure', target: 'collect', reason: 'BUDGET_EXCEEDED' },
    async (directory) => {
      expect(await completedOutcome(api, { ...run, conclusion: 'failure' }, directory)).toEqual({
        conclusion: 'failure',
        target: 'collect',
        reason: 'BUDGET_EXCEEDED',
      });
    },
  ));
it('異なる試行や不正な記録を受け入れない', () =>
  report(
    { attempt: '2', status: 'success', target: 'publish', reason: 'REVIEW_COMPLETE' },
    async (directory) => {
      expect((await completedOutcome(api, run, directory)).reason).toBe('REPORT_INVALID');
    },
  ));
it('記録前の投稿ジョブ失敗でも対象と理由を返す', async () => {
  expect(await completedOutcome(api, { ...run, conclusion: 'failure' })).toEqual({
    conclusion: 'failure',
    target: 'publish',
    reason: 'PUBLISH_FAILED',
  });
});
it('投稿記録のない正常終了を成功にしない', async () => {
  expect((await completedOutcome(api, run)).reason).toBe('REPORT_MISSING');
});
it('元実行の時間切れとキャンセルを区別する', async () => {
  expect((await completedOutcome(api, { ...run, conclusion: 'cancelled' })).reason).toBe(
    'CANCELLED',
  );
  expect((await completedOutcome(api, { ...run, conclusion: 'timed_out' })).reason).toBe(
    'TIMED_OUT',
  );
});
it('検証したサブコードと不足分類をPRの表示結果へ引き継ぐ', () =>
  report(
    {
      job: 'generate',
      status: 'failure',
      target: 'task-1',
      reason: 'INCOMPLETE',
      diagnostic: { subcode: 'MISSING_CONTEXT', missing: ['CONTRACT'] },
    },
    async (directory) => {
      expect(
        await completedOutcome(api, { ...run, conclusion: 'failure' }, directory),
      ).toMatchObject({
        conclusion: 'failure',
        reason: 'INCOMPLETE',
        diagnostic: { subcode: 'MISSING_CONTEXT', missing: ['CONTRACT'] },
      });
    },
  ));
it('診断へ自由文を追加したArtifactを拒否する', () =>
  report(
    {
      job: 'generate',
      status: 'failure',
      target: 'task-1',
      reason: 'INCOMPLETE',
      diagnostic: { subcode: 'MISSING_CONTEXT', missing: ['CONTRACT'], text: 'SECRET' },
    },
    async (directory) => {
      expect(await completedOutcome(api, { ...run, conclusion: 'failure' }, directory)).toEqual({
        conclusion: 'failure',
        target: 'artifact',
        reason: 'REPORT_INVALID',
      });
    },
  ));
