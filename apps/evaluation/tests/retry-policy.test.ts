import { expect, test } from 'vitest';
import { retryDelayMs, maxEvaluationAttempts } from '../src/domain/retry-policy';

test('再試行可能な失敗の1回目は30秒待機する', () => {
  expect(retryDelayMs(1, { code: 'TEMPORARY', retryable: true })).toBe(30_000);
});

test('再試行可能な失敗の2回目は120秒待機する', () => {
  expect(retryDelayMs(2, { code: 'TEMPORARY', retryable: true })).toBe(120_000);
});

test('再試行可能な失敗の3回目は300秒待機する', () => {
  expect(retryDelayMs(3, { code: 'TEMPORARY', retryable: true })).toBe(300_000);
});

test('再試行可能な失敗でも4回目は再試行しない', () => {
  expect(retryDelayMs(4, { code: 'TEMPORARY', retryable: true })).toBe(null);
});

test('共有の最大試行回数に達した失敗は再試行しない', () => {
  expect(retryDelayMs(maxEvaluationAttempts, { code: 'TEMPORARY', retryable: true })).toBeNull();
  expect(retryDelayMs(maxEvaluationAttempts - 1, { code: 'TEMPORARY', retryable: true })).toBe(
    300_000,
  );
});

test('再試行不可の失敗には次回待機を返さない', () => {
  expect(retryDelayMs(1, { code: 'PERMANENT', retryable: false })).toBeNull();
});

test('Retry-Afterが10000msなら待機は30000ms', () => {
  expect(retryDelayMs(1, { code: 'THROTTLED', retryable: true, retryAfterMs: 10000 })).toBe(30000);
});

test('Retry-Afterが60000msなら待機は60000ms', () => {
  expect(retryDelayMs(1, { code: 'THROTTLED', retryable: true, retryAfterMs: 60000 })).toBe(60000);
});

test('再試行可能な失敗でもRetry-Afterが-1なら拒否する', () => {
  expect(() => retryDelayMs(1, { code: 'THROTTLED', retryable: true, retryAfterMs: -1 })).toThrow(
    '再試行時刻が不正です。',
  );
});

test('再試行可能な失敗でもRetry-AfterがNaNなら拒否する', () => {
  expect(() => retryDelayMs(1, { code: 'THROTTLED', retryable: true, retryAfterMs: NaN })).toThrow(
    '再試行時刻が不正です。',
  );
});

test('再試行可能な失敗でもRetry-AfterがInfinityなら拒否する', () => {
  expect(() =>
    retryDelayMs(1, { code: 'THROTTLED', retryable: true, retryAfterMs: Infinity }),
  ).toThrow('再試行時刻が不正です。');
});
