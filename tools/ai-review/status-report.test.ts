import { expect, it, onTestFinished } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeStatusReport,
  readStatusReports,
  recordExecutionFailure,
  validReport,
} from './status-report.ts';
import { detail } from './diagnostics.ts';

function directoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'report-boundaries-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

it('診断付き失敗と予算通知のコメントIDを保存して読み戻す', () => {
  const directory = directoryFixture();
  const env = {
    RUNNER_TEMP: directory,
    GITHUB_RUN_ID: '20',
    GITHUB_RUN_ATTEMPT: '1',
    AI_REVIEW_JOB: 'publish',
  };
  const diagnostic = detail('MISSING_CONTEXT', ['CONTRACT']);
  writeStatusReport(env, 'failure', 'publish', 'OUTPUT_INVALID', diagnostic);
  expect(readStatusReports(directory, 20, 1)[0].diagnostic).toEqual(diagnostic);
  writeStatusReport(env, 'success', 'publish', 'BUDGET_NOTIFIED', undefined, 42);
  expect(readStatusReports(directory, 20, 1)[0].commentId).toBe(42);
});

it('必須フィールドの欠落を成功扱いしない', () => {
  const report = {
    version: 1 as const,
    run: '20',
    attempt: '1',
    job: 'publish' as const,
    status: 'success' as const,
    target: 'publish',
    reason: 'REVIEW_COMPLETE' as const,
  };
  expect(validReport(report)).toBe(true);
  expect(validReport({ ...report, job: undefined })).toBe(false);
  expect(validReport({ ...report, status: undefined })).toBe(false);
  expect(validReport({ ...report, target: undefined })).toBe(false);
  expect(validReport({ ...report, reason: undefined })).toBe(false);
});

it('保存先未設定時は副作用なく終了する', () => {
  expect(() => writeStatusReport({}, 'failure', 'generate', 'EXECUTION_FAILED')).not.toThrow();
  expect(() => recordExecutionFailure({})).not.toThrow();
  expect(readStatusReports(undefined, 20, 1)).toEqual([]);
});

it('結果ファイルの位置にディレクトリがあれば拒否する', () => {
  const directory = directoryFixture();
  mkdirSync(join(directory, 'status.json'));
  expect(() => readStatusReports(directory, 20, 1)).toThrow('実行結果が大きすぎます');
});

it('単一Artifactとジョブ別Artifactの混在を拒否する', () => {
  const directory = directoryFixture();
  const report = {
    version: 1,
    run: '20',
    attempt: '1',
    job: 'gate',
    status: 'failure',
    target: 'gate',
    reason: 'AUTH_FAILED',
  };
  const job = join(directory, 'ai-review-status-20-1-gate');
  mkdirSync(job);
  writeFileSync(join(job, 'status.json'), JSON.stringify(report));
  writeFileSync(join(directory, 'status.json'), JSON.stringify(report));
  expect(() => readStatusReports(directory, 20, 1)).toThrow('混在');
});
it('未検証の対象IDを結果ファイルに出力しない', () => {
  expect(() =>
    writeStatusReport(
      {
        AI_REVIEW_REPORT: '/unused',
        GITHUB_RUN_ID: '20',
        GITHUB_RUN_ATTEMPT: '1',
        AI_REVIEW_JOB: 'generate',
      },
      'failure',
      'SECRET\nmessage',
      'MODEL_FAILED',
    ),
  ).toThrow();
});
it('ジョブenvでrunnerコンテキストを使わず実行時RUNNER_TEMPへ結果を保存する', () => {
  const directory = mkdtempSync(join(tmpdir(), 'report-runtime-path-'));
  try {
    writeStatusReport(
      {
        RUNNER_TEMP: directory,
        GITHUB_RUN_ID: '20',
        GITHUB_RUN_ATTEMPT: '1',
        AI_REVIEW_JOB: 'gate',
      },
      'success',
      'gate',
      'ALREADY_COMPLETE',
    );
    expect(JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))).toMatchObject({
      run: '20',
      attempt: '1',
      job: 'gate',
      reason: 'ALREADY_COMPLETE',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
