import { parseJson } from '@korekaite/api-contracts/json';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assert, expect, test } from 'vitest';
import { runDiagnosticScenario } from '../src/integration.ts';

test('受付応答の本文を失った後も同じキーで再送し、ジョブと受付を一件のまま完了する', async () => {
  const { report, resultPath } = await runDiagnosticScenario({
    runId: randomUUID(),
    parallelIndex: 0,
    scenario: 'success',
    fault: 'response_loss',
  });
  expect(report).toMatchObject({
    environment: 'test',
    case: 'response_loss',
    clock: 'real',
    exitCode: 0,
    expected: { acceptanceCounts: { jobs: 1, requests: 1 } },
    actual: {
      responseDiscarded: true,
      startHttpStatus: 202,
      retryHttpStatus: 202,
      acceptanceBeforeRetry: { jobs: 1, requests: 1 },
      acceptanceAfterRetry: { jobs: 1, requests: 1 },
      status: 'completed',
      attemptCount: 1,
      queueObserved: true,
      checks: { doPersistence: 'passed', consumerCompletion: 'passed', dlqReceipt: 'not_expected' },
    },
  });
  expect(parseJson(await readFile(resultPath, 'utf8'))).toEqual(report);
}, 120_000);

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
