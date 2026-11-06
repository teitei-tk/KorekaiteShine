import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { runDiagnosticScenario } from '../src/integration.ts';

test('全4回失敗を実時間30・120・300秒で試行し、定期回復と実DLQ受信を記録する', async () => {
  const { report, resultPath } = await runDiagnosticScenario({
    runId: randomUUID(),
    parallelIndex: 0,
    scenario: 'exhaust_retries',
  });
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
