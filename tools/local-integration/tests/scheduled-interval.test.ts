import { afterEach, expect, test, vi } from 'vitest';
import { startScheduledInterval } from '../src/scheduled-interval.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('タイマーが期限より早く発火しても60秒経過するまでscheduledを呼ばない', () => {
  vi.useFakeTimers();
  const nowState = { now: 100 };
  vi.spyOn(performance, 'now').mockImplementation(() => nowState.now);
  const invocations: number[] = [];
  const stop = startScheduledInterval((elapsed) => invocations.push(elapsed), 60_000);
  try {
    nowState.now = 60_099;
    vi.advanceTimersByTime(60_000);
    expect(invocations).toEqual([]);
    nowState.now = 60_100;
    vi.advanceTimersByTime(1);
    expect(invocations).toEqual([60_000]);
  } finally {
    stop();
  }
});

test('壁時計が戻っても実経過時間で周期を保ち、停止後は呼び出さない', () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  const invocations: number[] = [];
  const stop = startScheduledInterval((elapsed) => invocations.push(elapsed), 60_000);
  vi.advanceTimersByTime(30_000);
  vi.setSystemTime(Temporal.Now.instant().epochMilliseconds - 10_000);
  vi.advanceTimersByTime(30_000);
  expect(invocations).toEqual([60_000]);
  vi.advanceTimersByTime(60_000);
  expect(invocations).toEqual([60_000, 120_000]);
  stop();
  vi.advanceTimersByTime(60_000);
  expect(invocations).toEqual([60_000, 120_000]);
});

test('期限を大きく過ぎても追いつくための連続呼び出しを行わない', () => {
  vi.useFakeTimers();
  const nowState = { now: 0 };
  vi.spyOn(performance, 'now').mockImplementation(() => nowState.now);
  const invocations: number[] = [];
  const stop = startScheduledInterval((elapsed) => invocations.push(elapsed), 60_000);
  try {
    nowState.now = 180_000;
    vi.advanceTimersByTime(60_000);
    expect(invocations).toEqual([180_000]);
    nowState.now = 239_999;
    vi.advanceTimersByTime(59_999);
    expect(invocations).toEqual([180_000]);
    nowState.now = 240_000;
    vi.advanceTimersByTime(1);
    expect(invocations).toEqual([180_000, 240_000]);
  } finally {
    stop();
  }
});
