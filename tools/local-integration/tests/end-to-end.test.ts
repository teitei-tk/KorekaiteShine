import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { beforeAll, expect, test } from 'vitest';
import { runDiagnosticScenario } from '../src/integration.ts';
import { runDiagnosticIntegration } from '../src/integration-run.ts';

const results = new Map<string, Awaited<ReturnType<typeof runDiagnosticScenario>>>();
beforeAll(async () => {
  const summary = await runDiagnosticIntegration(async (input) => {
    const result = await runDiagnosticScenario(input);
    results.set(input.scenario, result);
    console.log(`統合検証結果: ${result.resultPath}`);
  });
  expect(summary.exitCode, `実行ID: ${summary.runId}`).toBe(0);
}, 900_000);

test('実HTTPの正常系がDO・Queue・Consumer・D1を通り、実測結果だけを残す', async () => {
  const { report, resultPath } = results.get('success')!;
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
  const { report, resultPath } = results.get('retry_then_success')!;
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

test('全4回失敗を実時間30・120・300秒で試行し、定期回復と実DLQ受信を記録する', async () => {
  const { report, resultPath } = results.get('exhaust_retries')!;
  expect(report).toMatchObject({
    case: 'exhaust_retries',
    clock: 'real',
    exitCode: 0,
    expected: { status: 'failed', attemptCount: 4, retryDelaysMs: [30_000, 120_000, 300_000] },
    actual: {
      status: 'failed',
      attemptCount: 4,
      queueObserved: true,
      checks: { doPersistence: 'passed', consumerCompletion: 'not_expected', dlqReceipt: 'passed' },
    },
  });
  expect(report.actual.queue).toMatch(/-dlq$/);
  expect(report.attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3, 4]);
  for (const [index, minimum] of [30_000, 120_000, 300_000].entries()) {
    expect(
      report.attempts[index + 1]!.startedAt - report.attempts[index]!.finishedAt,
    ).toBeGreaterThanOrEqual(minimum);
  }
  expect(report.scheduled.intervalMs).toBe(60_000);
  expect(report.scheduled.invocations.length).toBeGreaterThanOrEqual(7);
  expect(report.scheduled.invocations.length).toBeLessThanOrEqual(
    Math.floor(report.durationMs! / 60_000),
  );
  expect(report.scheduled.invocations.every((invocation) => invocation.outcome === 'ok')).toBe(
    true,
  );
  expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual(report);
}, 720_000);
