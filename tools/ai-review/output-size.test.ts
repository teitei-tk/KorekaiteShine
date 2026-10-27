import { expect, it } from 'vitest';
import { historyOutputBytes, HISTORY_RESULT_BYTES } from './output-size.ts';
import type { ReviewTask } from './partition.ts';
it('根拠文字列のJSONエスケープと資料ID数を履歴出力量へ含める', () => {
  const task: ReviewTask = {
    id: 'history',
    kind: 'history',
    sources: ['a'.repeat(64)],
    obligations: ['b'.repeat(16)],
    priorIds: ['1:1'],
  };
  expect(historyOutputBytes(task)).toBeGreaterThan(750 * 6 + 500 * 6);
  expect(
    historyOutputBytes({ ...task, sources: [...task.sources, 'c'.repeat(64)] }),
  ).toBeGreaterThan(historyOutputBytes(task));
  expect(
    historyOutputBytes({ ...task, priorIds: Array.from({ length: 30 }, (_, i) => `${i + 1}:1`) }),
  ).toBeGreaterThan(HISTORY_RESULT_BYTES);
});
