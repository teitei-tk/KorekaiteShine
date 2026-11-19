import { parseJson } from '@korekaite/api-contracts/json';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assert, expect, test } from 'vitest';
import { runDiagnosticScenario } from './helpers/restart-scenario.ts';

test('Queue送信直後の停止からD1の未送信outboxを回復し、実Consumerが一度だけ評価する', async () => {
  const { report, resultPath } = await runDiagnosticScenario({
    runId: randomUUID(),
    parallelIndex: 0,
    scenario: 'success',
    fault: 'after_queue_send',
  });
  expect(report).toMatchObject({
    case: 'after_queue_send',
    clock: 'real',
    exitCode: 0,
    actual: {
      initializationHttpStatus: 500,
      queueBeforeRestart: true,
      beforeRestartStatus: 'pending',
      beforeRestartChecks: { doPersistence: 'passed', consumerCompletion: 'pending' },
      dispatchBeforeRestart: { notifications: 1, unsent: 1, deliveries: 1 },
      dispatchAfterRestart: { notifications: 1, unsent: 0 },
      queueRecovery: 'd1_outbox',
      restartCount: 1,
      status: 'completed',
      attemptCount: 1,
      queueObserved: true,
    },
  });
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
