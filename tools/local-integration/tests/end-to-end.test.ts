import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { runDiagnosticScenario } from '../src/integration.ts';
import { randomUUID } from 'node:crypto';

test('実HTTPの正常系がDO・Queue・Consumer・D1を通り、実測結果だけを残す', async () => {
  const { report, resultPath } = await runDiagnosticScenario({
    runId: randomUUID(),
    parallelIndex: 0,
    scenario: 'success',
  });
  const runId = report.runId;
  expect(report).toMatchObject({
    environment: 'test',
    runId,
    parallelIndex: 0,
    case: 'success',
    mode: 'dev',
    clock: 'real',
    exitCode: 0,
    expected: {
      status: 'completed',
      attemptCount: 1,
      checks: { doPersistence: 'passed', consumerCompletion: 'passed', dlqReceipt: 'not_expected' },
    },
    actual: {
      startHttpStatus: 202,
      statusHttpStatus: 200,
      status: 'completed',
      attemptCount: 1,
      checks: { doPersistence: 'passed', consumerCompletion: 'passed', dlqReceipt: 'not_expected' },
      queueObserved: true,
    },
  });
  expect(report.actual.queue).toMatch(/^korekaite-diagnostics-test-/);
  expect(report.versions.node).toBe(process.version);
  const installed = JSON.parse(
    await readFile(new URL('../node_modules/void/package.json', import.meta.url), 'utf8'),
  );
  expect(report.versions.void).toBe(installed.version);
  const stored = JSON.parse(await readFile(resultPath, 'utf8'));
  expect(stored).toEqual(report);
  expect(resultPath).toMatch(new RegExp(`/\\.local/tests/${runId}/0/results\\.json$`));
  expect(Object.keys(report.actual).sort()).toEqual([
    'attemptCount',
    'checks',
    'jobId',
    'queue',
    'queueObserved',
    'startHttpStatus',
    'status',
    'statusHttpStatus',
  ]);
  await expect(stat(join(dirname(resultPath), 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(dirname(resultPath), 'artifacts'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}, 120_000);

test('一時失敗は実時間で30秒待って2回目に成功し、D1の試行時刻を証拠に残す', async () => {
  const { report, resultPath } = await runDiagnosticScenario({
    runId: randomUUID(),
    parallelIndex: 0,
    scenario: 'retry_then_success',
  });
  expect(report).toMatchObject({
    case: 'retry_then_success',
    clock: 'real',
    exitCode: 0,
    expected: { status: 'completed', attemptCount: 2, retryDelaysMs: [30_000] },
    actual: {
      status: 'completed',
      attemptCount: 2,
      queueObserved: true,
      checks: { doPersistence: 'passed', consumerCompletion: 'passed', dlqReceipt: 'not_expected' },
    },
  });
  expect(report.attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
  expect(report.attempts[1]!.startedAt - report.attempts[0]!.finishedAt).toBeGreaterThanOrEqual(
    30_000,
  );
  expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual(report);
}, 180_000);
