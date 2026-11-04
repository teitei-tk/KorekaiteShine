import { expect, it } from 'vitest';
import { formatStartedAt } from '../src/lib/date-time';

it('開始日時を日本時間へ変換し、日付をまたいでも秒まで表示する', () => {
  expect(formatStartedAt('2026-11-03T15:00:00Z')).toBe('2026/11/4 0:00:00');
  expect(formatStartedAt('2026-11-04T00:00:00+09:00')).toBe('2026/11/4 0:00:00');
});
