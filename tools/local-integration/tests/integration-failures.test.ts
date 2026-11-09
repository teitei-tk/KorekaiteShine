import { expect, test, vi } from 'vitest';
import { scenarioFixture } from './helpers/integration-scenario.ts';
import { startRuntime } from '../src/runtime.ts';

test('ネイティブ再配送を待つ間のscheduled失敗も成功扱いしない', async () => {
  const fixture = scenarioFixture('success', 'after_result_before_ack');
  vi.mocked(fixture.runtime.runScheduled).mockRejectedValue(new Error('private details'));
  fixture.replies.nativeRetry = async () => {
    await fixture.advance(60_000);
    return Response.json(fixture.nativeRetry);
  };
  await fixture.fails('SCHEDULED_FAILED');
});

test('再試行上限後のDLQ配送と待機時間を検証する', async () => {
  const fixture = scenarioFixture('exhaust_retries');
  const { report } = await fixture.run();
  expect(report.actual.status).toBe('failed');
  expect(report.actual.queueObserved).toBe(true);
  expect(report.attempts).toHaveLength(4);
});

test('結果保存前の停止はack前停止シナリオの証拠にしない', async () => {
  const fixture = scenarioFixture('success', 'after_result_before_ack');
  fixture.replies.nativeRetry = () =>
    Response.json({
      ...fixture.nativeRetry,
      stop: { ...fixture.nativeRetry.stop, occurredAt: fixture.base },
    });
  await fixture.fails('STOP_BEFORE_RESULT');
});

test('ack前停止後の再起動で結果が変わっていれば拒否する', async () => {
  const fixture = scenarioFixture('success', 'after_result_before_ack');
  fixture.replies.status = () =>
    Response.json(
      vi.mocked(startRuntime).mock.calls.length < 2
        ? fixture.completed
        : { ...fixture.completed, status: 'cancelled' },
    );
  await fixture.fails('RESTART_RESULT_MISMATCH');
});

test('ackが観測されない再配送は期限で停止する', async () => {
  const fixture = scenarioFixture('success', 'after_result_before_ack');
  fixture.replies.nativeRetry = () =>
    Response.json({ ...fixture.nativeRetry, acknowledgedMessageId: null });
  await fixture.fails('NATIVE_RETRY_TIMEOUT');
  expect(fixture.clock.milliseconds).toBe(90_000);
});

test('ネイティブ再配送が短すぎれば正しい回復としない', async () => {
  const fixture = scenarioFixture('success', 'after_result_before_ack');
  fixture.replies.nativeRetry = () =>
    Response.json({
      ...fixture.nativeRetry,
      deliveries: [
        fixture.nativeRetry.deliveries[0],
        { ...fixture.nativeRetry.deliveries[1], receivedAt: fixture.base + 29_999 },
      ],
    });
  await fixture.fails('NATIVE_RETRY_MISMATCH');
});

test('ack前停止の証拠が別Queueなら拒否する', async () => {
  const fixture = scenarioFixture('success', 'after_result_before_ack');
  fixture.replies.nativeRetry = () =>
    Response.json({
      ...fixture.nativeRetry,
      stop: { ...fixture.nativeRetry.stop, queue: 'wrong-queue' },
    });
  await fixture.fails('NATIVE_RETRY_CONTRACT');
});

test('ack前停止の再配送証拠が配列でなければ拒否する', async () => {
  const fixture = scenarioFixture('success', 'after_result_before_ack');
  fixture.replies.nativeRetry = () => Response.json({ ...fixture.nativeRetry, deliveries: {} });
  await fixture.fails('NATIVE_RETRY_CONTRACT');
});

test('再起動後に未送信のまま残るOutboxを回復済みとしない', async () => {
  const fixture = scenarioFixture('success', 'after_queue_send');
  fixture.replies.dispatch = () => Response.json({ notifications: 1, unsent: 1, deliveries: 1 });
  await fixture.fails('OUTBOX_RECOVERY_MISMATCH');
});

test('再起動後に失われたDO保存時刻を成功としない', async () => {
  const fixture = scenarioFixture('success', 'after_do_save');
  fixture.replies.persistence = () => Response.json({ firstReceivedAt: null });
  await fixture.fails('DO_STATE_NOT_PRESERVED');
});

test('再起動後scheduledより前に完了した結果を回復処理の証拠としない', async () => {
  const fixture = scenarioFixture('success', 'after_acceptance');
  fixture.replies.status = () =>
    Response.json(
      vi.mocked(startRuntime).mock.calls.length < 2 ? fixture.pending : fixture.completed,
    );
  await fixture.fails('RECOVERY_SCHEDULE_MISMATCH');
});

test('再起動前に処理が完了していれば復旧の成功としない', async () => {
  const fixture = scenarioFixture('success', 'after_acceptance');
  fixture.replies.status = () => Response.json(fixture.completed);
  await fixture.fails('RESTART_BOUNDARY_MISMATCH');
});

test('停止前Outboxが送信済みなら障害境界の不一致にする', async () => {
  const fixture = scenarioFixture('success', 'after_queue_send');
  fixture.replies.dispatch = () => Response.json({ notifications: 1, unsent: 0, deliveries: 1 });
  await fixture.fails('RESTART_BOUNDARY_MISMATCH');
});

test('停止前Outbox証拠の非整数を拒否する', async () => {
  const fixture = scenarioFixture('success', 'after_queue_send');
  fixture.replies.dispatch = () => Response.json({ notifications: 1, unsent: 1, deliveries: 0.5 });
  await fixture.fails('DISPATCH_CONTRACT');
});

test('Queue配送の停止前証拠が得られなければ期限で失敗する', async () => {
  const fixture = scenarioFixture('success', 'after_queue_send');
  fixture.replies.receipt = () => Response.json(null);
  await fixture.fails('QUEUE_RECEIPT_TIMEOUT');
  expect(fixture.clock.milliseconds).toBe(10_000);
});

test('DO保存後の停止境界で配送済みなら想定した障害境界として扱わない', async () => {
  const fixture = scenarioFixture('success', 'after_do_save');
  fixture.replies.persistence = () => Response.json({ firstReceivedAt: fixture.base });
  await fixture.fails('RESTART_BOUNDARY_MISMATCH');
});

test('DO保存の証拠が時刻でもnullでもなければ拒否する', async () => {
  const fixture = scenarioFixture('success', 'after_do_save');
  fixture.replies.persistence = () => Response.json({ firstReceivedAt: 'invalid' });
  await fixture.fails('PERSISTENCE_CONTRACT');
});

test('注入したDO保存後の障害が発生しなければ復旧検証を成功にしない', async () => {
  const fixture = scenarioFixture('success', 'after_do_save');
  fixture.replies.initialize = () => new Response('ok');
  await fixture.fails('FAULT_NOT_OBSERVED');
});

test('応答喪失後の再送による重複受付を成功にしない', async () => {
  const fixture = scenarioFixture('success', 'response_loss');
  let reads = 0;
  fixture.replies.counts = () => Response.json({ jobs: 1, requests: ++reads });
  await fixture.fails('ACCEPTANCE_COUNTS_MISMATCH');
  expect(reads).toBe(2);
});

test('応答喪失後の再送前に重複ジョブがあれば失敗する', async () => {
  const fixture = scenarioFixture('success', 'response_loss');
  fixture.replies.counts = () => Response.json({ jobs: 2, requests: 1 });
  await fixture.fails('ACCEPTANCE_COUNTS_MISMATCH');
});

test('応答喪失後の受付件数が不正な型なら証拠を拒否する', async () => {
  const fixture = scenarioFixture('success', 'response_loss');
  fixture.replies.counts = () => Response.json({ jobs: 1, requests: '1' });
  await fixture.fails('ACCEPTANCE_COUNTS_CONTRACT');
});

test('応答を破棄しても受付が202以外なら契約失敗にする', async () => {
  const fixture = scenarioFixture('success', 'response_loss');
  fixture.clock.httpStatus = 400;
  await fixture.fails('ACCEPTANCE_CONTRACT');
});

test('制御した応答も実際のHTTP契約で検証し、成功時は証拠と停止を完了する', async () => {
  const fixture = scenarioFixture();
  const { report } = await fixture.run();
  expect(report.exitCode).toBe(0);
  expect(report.actual.queueObserved).toBe(true);
  expect(report.attempts).toEqual(fixture.attempts);
  expect(fixture.runtime.stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('受付のHTTP契約違反を成功扱いせず応答本文を証拠へ転記しない', async () => {
  const fixture = scenarioFixture();
  fixture.replies.accept = () => Response.json({ error: 'private details' }, { status: 500 });
  await fixture.fails('ACCEPTANCE_CONTRACT');
  expect(fixture.runtime.stop).toHaveBeenCalledTimes(1);
});

test('別ジョブの状態応答を対象ジョブの成功として採用しない', async () => {
  const fixture = scenarioFixture();
  fixture.replies.status = () =>
    Response.json({
      ...fixture.completed,
      jobId: '00000000-0000-4000-8000-000000000001',
    });
  await fixture.fails('STATUS_CONTRACT');
});

test('契約上は正しい終端状態でも期待結果と異なれば失敗する', async () => {
  const fixture = scenarioFixture();
  fixture.replies.status = () => Response.json({ ...fixture.completed, status: 'cancelled' });
  await fixture.fails('OUTCOME_MISMATCH');
});

test('Queue配送の観測が別Queueを指していれば実配送の成功としない', async () => {
  const fixture = scenarioFixture();
  fixture.replies.receipt = () => Response.json({ ...fixture.receipt, queue: 'wrong-queue' });
  await fixture.fails('QUEUE_RECEIPT_MISMATCH');
});

test('試行履歴の終了時刻が開始時刻より前なら成功記録を拒否する', async () => {
  const fixture = scenarioFixture();
  fixture.replies.attempts = () =>
    Response.json([{ ...fixture.attempts[0], finishedAt: fixture.base - 1 }]);
  await fixture.fails('ATTEMPT_HISTORY');
});

test('再試行の待機時間が規定より短い履歴を成功記録にしない', async () => {
  const fixture = scenarioFixture('retry_then_success');
  fixture.replies.attempts = () =>
    Response.json([
      fixture.attempts[0],
      { attemptNumber: 2, startedAt: fixture.base + 30_000, finishedAt: fixture.base + 30_001 },
    ]);
  await fixture.fails('RETRY_TOO_EARLY');
});

test('終端状態へ進まない応答は検証期限で失敗し周期タイマーを解除する', async () => {
  const fixture = scenarioFixture();
  fixture.replies.status = () => Response.json(fixture.pending);
  await fixture.fails('TIMEOUT');
  expect(fixture.clock.milliseconds).toBe(60_000);
  expect(fixture.runtime.stop).toHaveBeenCalledTimes(1);
});

test('scheduledが失敗すると後続の周期起動を抑止し検証全体を失敗にする', async () => {
  const fixture = scenarioFixture();
  vi.mocked(fixture.runtime.runScheduled).mockRejectedValue(new Error('private details'));
  fixture.replies.accept = async () => {
    await fixture.advance(60_000);
    await fixture.advance(60_000);
    return Response.json(fixture.accepted, { status: 202 });
  };
  const report = await fixture.fails('SCHEDULED_FAILED');
  expect(fixture.runtime.runScheduled).toHaveBeenCalledTimes(1);
  expect(report.scheduled.invocations).toHaveLength(1);
  expect(report.scheduled.invocations[0].outcome).toBe('failed');
});

test('ランタイムを開始できない場合は内部例外を保存せず失敗を返す', async () => {
  const fixture = scenarioFixture();
  vi.mocked(startRuntime).mockRejectedValue(new Error('private details'));
  await fixture.fails('UNEXPECTED_ERROR', 'private details');
  expect(fixture.runtime.stop).not.toHaveBeenCalled();
});

test('ランタイム開始の非Error例外を公開用のエラーへ変換する', async () => {
  const fixture = scenarioFixture();
  vi.mocked(startRuntime).mockRejectedValue('private details');
  await fixture.fails('UNEXPECTED_ERROR', '統合検証に失敗しました。');
});

test('検証成功後でもランタイムの停止に失敗すれば失敗の証拠を残す', async () => {
  const fixture = scenarioFixture();
  vi.mocked(fixture.runtime.stop).mockRejectedValue(new Error('private details'));
  await fixture.fails('CLEANUP_FAILED', 'private details');
});

test('停止処理の非Error例外にも停止失敗の分類と公開用エラーを与える', async () => {
  const fixture = scenarioFixture();
  vi.mocked(fixture.runtime.stop).mockRejectedValue('private details');
  await fixture.fails('CLEANUP_FAILED', '統合検証の停止・破棄に失敗しました。');
});

test.each([
  'after_acceptance',
  'after_do_save',
  'after_queue_send',
  'after_result_before_ack',
  'response_loss',
] as const)('%sの制御した正常な復旧証拠を受理する', async (fault) => {
  const fixture = scenarioFixture('success', fault);
  const { report } = await fixture.run();
  expect(report.exitCode).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
