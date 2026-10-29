import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStatusReport } from './status-report.ts';
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
