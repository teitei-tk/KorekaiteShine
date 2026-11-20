import { parseJson } from '@korekaite/api-contracts/json';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assert, expect, test } from 'vitest';
import { runDiagnosticScenario } from './helpers/restart-scenario.ts';

test('受付直後の停止から再起動し、実時間60秒周期のscheduledで全経路を回復する', async () => {
  const { report, resultPath } = await runDiagnosticScenario({
    runId: randomUUID(),
    parallelIndex: 0,
    scenario: 'success',
    fault: 'after_acceptance',
  });
  expect(report).toMatchObject({
    case: 'after_acceptance',
    clock: 'real',
    exitCode: 0,
    actual: {
      beforeRestartStatus: 'pending',
      restartCount: 1,
      status: 'completed',
      attemptCount: 1,
      queueObserved: true,
      checks: { doPersistence: 'passed', consumerCompletion: 'passed', dlqReceipt: 'not_expected' },
    },
  });
  expect(
    (report.restart ?? assert.fail('必須のテスト値がありません。')).restartedAt,
  ).toBeGreaterThanOrEqual(
    (report.restart ?? assert.fail('必須のテスト値がありません。')).stoppedAt,
  );
  expect(report.scheduled.invocations.length).toBeGreaterThanOrEqual(1);
  expect(
    (report.scheduled.invocations[0] ?? assert.fail('必須のテスト値がありません。')).elapsedMs,
  ).toBeGreaterThanOrEqual(60_000);
  expect(report.scheduled.invocations.every((entry) => entry.outcome === 'ok')).toBe(true);
  expect(
    (report.attempts[0] ?? assert.fail('必須のテスト値がありません。')).startedAt,
  ).toBeGreaterThanOrEqual(
    (report.scheduled.invocations[0] ?? assert.fail('必須のテスト値がありません。')).startedAt,
  );
  expect(parseJson(await readFile(resultPath, 'utf8'))).toEqual(report);
}, 180_000);
