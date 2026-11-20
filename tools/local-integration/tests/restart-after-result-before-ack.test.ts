import { parseJson } from '@korekaite/api-contracts/json';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assert, expect, test } from 'vitest';
import { runDiagnosticScenario } from './helpers/restart-scenario.ts';

test('結果保存後ack前のConsumer例外終了を実Queueが再配送し、再起動後も評価は一回に保つ', async () => {
  const { report, resultPath } = await runDiagnosticScenario({
    runId: randomUUID(),
    parallelIndex: 0,
    scenario: 'success',
    fault: 'after_result_before_ack',
  });
  expect(report).toMatchObject({
    case: 'after_result_before_ack',
    clock: 'real',
    exitCode: 0,
    actual: {
      consumerStop: { kind: 'exception' },
      acknowledgedAfterStop: true,
      queueRecovery: 'native_retry',
      beforeRestartStatus: 'completed',
      restartCount: 1,
      status: 'completed',
      attemptCount: 1,
      queueObserved: true,
    },
  });
  const deliveries =
    report.actual.nativeDeliveryAttempts ?? assert.fail('必須のテスト値がありません。');
  expect(deliveries.map((entry) => entry.attempt)).toEqual([1, 2]);
  expect(new Set(deliveries.map((entry) => entry.messageId))).toEqual(
    new Set([
      (report.actual.consumerStop ?? assert.fail('必須のテスト値がありません。')).messageId,
    ]),
  );
  expect(
    (deliveries[1] ?? assert.fail('必須のテスト値がありません。')).receivedAt -
      (deliveries[0] ?? assert.fail('必須のテスト値がありません。')).receivedAt,
  ).toBeGreaterThanOrEqual(30_000);
  expect(
    (report.actual.consumerStop ?? assert.fail('必須のテスト値がありません。')).occurredAt,
  ).toBeLessThanOrEqual((deliveries[1] ?? assert.fail('必須のテスト値がありません。')).receivedAt);
  expect(
    (deliveries[1] ?? assert.fail('必須のテスト値がありません。')).receivedAt,
  ).toBeLessThanOrEqual((report.restart ?? assert.fail('必須のテスト値がありません。')).stoppedAt);
  expect(report.attempts).toHaveLength(1);
  expect(
    (report.attempts[0] ?? assert.fail('必須のテスト値がありません。')).finishedAt,
  ).toBeLessThanOrEqual(
    (report.actual.consumerStop ?? assert.fail('必須のテスト値がありません。')).occurredAt,
  );
  expect(parseJson(await readFile(resultPath, 'utf8'))).toEqual(report);
}, 180_000);
