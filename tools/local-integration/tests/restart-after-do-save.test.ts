import { parseJson } from '@korekaite/api-contracts/json';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assert, expect, test } from 'vitest';
import { runDiagnosticScenario } from './helpers/restart-scenario.ts';

test('DO保存後に停止しても初回保存時刻を維持し、再起動後のscheduledで完了する', async () => {
  const { report, resultPath } = await runDiagnosticScenario({
    runId: randomUUID(),
    parallelIndex: 0,
    scenario: 'success',
    fault: 'after_do_save',
  });
  expect(report).toMatchObject({
    case: 'after_do_save',
    clock: 'real',
    exitCode: 0,
    actual: {
      initializationHttpStatus: 500,
      beforeRestartFirstReceivedAt: null,
      beforeRestartStatus: 'pending',
      beforeRestartChecks: { doPersistence: 'pending' },
      restartCount: 1,
      status: 'completed',
      attemptCount: 1,
      queueObserved: true,
      checks: { doPersistence: 'passed', consumerCompletion: 'passed', dlqReceipt: 'not_expected' },
    },
  });
  expect(report.actual.doFirstReceivedAt).toBeGreaterThanOrEqual(
    Temporal.Instant.from(report.startedAt).epochMilliseconds,
  );
  expect(report.actual.doFirstReceivedAt).toBeLessThanOrEqual(
    report.actual.faultObservedAt ?? assert.fail('必須のテスト値がありません。'),
  );
  expect(report.actual.faultObservedAt).toBeLessThanOrEqual(
    (report.restart ?? assert.fail('必須のテスト値がありません。')).stoppedAt,
  );
  expect(
    (report.scheduled.invocations[0] ?? assert.fail('必須のテスト値がありません。')).elapsedMs,
  ).toBeGreaterThanOrEqual(60_000);
  expect(
    (report.attempts[0] ?? assert.fail('必須のテスト値がありません。')).startedAt,
  ).toBeGreaterThanOrEqual(
    (report.scheduled.invocations[0] ?? assert.fail('必須のテスト値がありません。')).startedAt,
  );
  expect(parseJson(await readFile(resultPath, 'utf8'))).toEqual(report);
}, 180_000);
