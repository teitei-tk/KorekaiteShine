import { afterEach, expect, test, vi } from 'vitest';
import { runEvaluationAttempt } from '../../../apps/evaluation/src/application/run-evaluation-attempt.ts';
import type { EvaluationResult } from '../../../apps/evaluation/src/domain/evaluation-result.ts';

afterEach(() => vi.useRealTimers());

function deferredEvaluation() {
  let finish: (value: EvaluationResult) => void = () => {
    throw new Error('評価待機の初期化前です。');
  };
  const promise = new Promise<EvaluationResult>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: finish };
}

test('AIが120秒で完了しなければ通信を中止し、再呼出しせず失敗を保存する', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_793_577_600_000);
  const aborted = vi.fn();
  const evaluate = vi.fn((signal: AbortSignal) => {
    signal.addEventListener('abort', aborted);
    return new Promise<EvaluationResult>(() => {});
  });
  const save = vi.fn(async (_result: EvaluationResult) => true);
  const result = runEvaluationAttempt({
    now: () => vi.getMockedSystemTime()!.getTime(),
    deadline: vi.getMockedSystemTime()!.getTime() + 180_000,
    evaluate,
    renew: async () => true,
    save,
  });
  await vi.advanceTimersByTimeAsync(119_999);
  expect(aborted).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe(true);
  expect(aborted).toHaveBeenCalledOnce();
  expect(evaluate).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledExactlyOnceWith({
    ok: false,
    error: { code: 'AI_TIMEOUT', retryable: true },
  });
  expect(vi.getTimerCount()).toBe(0);
});

test('評価中は30秒ごとに実行権を更新し、成功保存後に更新タイマーを解放する', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_793_577_600_000);
  const evaluated = deferredEvaluation();
  const renew = vi.fn(async () => true);
  const save = vi.fn(async (_result: EvaluationResult) => true);
  const result = runEvaluationAttempt({
    now: () => vi.getMockedSystemTime()!.getTime(),
    deadline: vi.getMockedSystemTime()!.getTime() + 180_000,
    evaluate: async () => evaluated.promise,
    renew,
    save,
  });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(renew).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(renew).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(renew).toHaveBeenCalledTimes(3);
  const success: EvaluationResult = { ok: true, value: { summary: '更新後の成功' } };
  evaluated.resolve(success);
  expect(await result).toBe(true);
  expect(save).toHaveBeenCalledExactlyOnceWith(success);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(renew).toHaveBeenCalledTimes(3);
});

test('実行権更新で所有権を失ったら評価を中止し、遅れて返った結果も保存しない', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_793_577_600_000);
  const evaluated = deferredEvaluation();
  const aborted = vi.fn();
  const renew = vi.fn(async () => false);
  const save = vi.fn(async (_result: EvaluationResult) => true);
  const result = runEvaluationAttempt({
    now: () => vi.getMockedSystemTime()!.getTime(),
    deadline: vi.getMockedSystemTime()!.getTime() + 180_000,
    evaluate: async (signal) => {
      signal.addEventListener('abort', aborted);
      return evaluated.promise;
    },
    renew,
    save,
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toBe(false);
  expect(renew).toHaveBeenCalledOnce();
  expect(aborted).toHaveBeenCalledOnce();
  evaluated.resolve({ ok: true, value: { summary: '失効後に届いた結果' } });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(save).not.toHaveBeenCalled();
  expect(renew).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test('保存だけが一時失敗した場合は同じ評価結果を再保存し、AIを呼び直さない', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_793_577_600_000);
  const value: EvaluationResult = { ok: true, value: { summary: '保存を再試行する結果' } };
  const evaluate = vi.fn(async () => value);
  const save = vi
    .fn(async (_result: EvaluationResult) => true)
    .mockRejectedValueOnce(new Error('一時的な保存障害'));
  const result = runEvaluationAttempt({
    now: () => vi.getMockedSystemTime()!.getTime(),
    deadline: vi.getMockedSystemTime()!.getTime() + 180_000,
    evaluate,
    renew: async () => true,
    save,
  }).catch(() => false);
  await vi.advanceTimersByTimeAsync(999);
  expect(save).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenNthCalledWith(1, value);
  expect(save).toHaveBeenNthCalledWith(2, value);
  expect(evaluate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test('保存失敗が続き更新処理も応答しなくても、180秒で試行と保存再試行を打ち切る', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_793_577_600_000);
  const deadline = vi.getMockedSystemTime()!.getTime() + 180_000;
  const evaluate = vi.fn(async (): Promise<EvaluationResult> => ({
    ok: true,
    value: { summary: '未保存の結果' },
  }));
  const renew = vi.fn(() => new Promise<boolean>(() => {}));
  const savedAt: number[] = [];
  const save = vi.fn(async (_result: EvaluationResult): Promise<boolean> => {
    savedAt.push(vi.getMockedSystemTime()!.getTime());
    throw new Error('保存先が応答できません。');
  });
  let settled = false;
  const result = runEvaluationAttempt({
    now: () => vi.getMockedSystemTime()!.getTime(),
    deadline,
    evaluate,
    renew,
    save,
  }).then((value) => {
    settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(179_999);
  expect(settled).toBe(false);
  expect(renew).toHaveBeenCalledOnce();
  expect(savedAt.length).toBeGreaterThan(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe(false);
  expect(evaluate).toHaveBeenCalledOnce();
  expect(savedAt.every((time) => time < deadline)).toBe(true);
  const attempts = save.mock.calls.length;
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(save).toHaveBeenCalledTimes(attempts);
});

test('実行権更新が例外で失敗したら評価を中止し、結果保存を開始しない', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_793_577_600_000);
  const evaluated = deferredEvaluation();
  const aborted = vi.fn();
  const renew = vi.fn(async (): Promise<boolean> => {
    throw new Error('更新先に接続できません。');
  });
  const save = vi.fn(async (_result: EvaluationResult) => true);
  const result = runEvaluationAttempt({
    now: () => vi.getMockedSystemTime()!.getTime(),
    deadline: vi.getMockedSystemTime()!.getTime() + 180_000,
    evaluate: async (signal) => {
      signal.addEventListener('abort', aborted);
      return evaluated.promise;
    },
    renew,
    save,
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toBe(false);
  expect(aborted).toHaveBeenCalledOnce();
  evaluated.resolve({ ok: true, value: { summary: '更新失敗後の結果' } });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(renew).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
