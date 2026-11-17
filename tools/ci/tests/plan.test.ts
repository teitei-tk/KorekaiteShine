import { expect, test } from 'vitest';
import { assignTests } from '../src/plan.ts';

test('長い順に最小シャードへ割り当てる', () => {
  expect(assignTests(['d', 'b', 'a', 'c'], { a: 8, b: 7, c: 6, d: 5 }, 2)).toStrictEqual([
    ['a', 'd'],
    ['b', 'c'],
  ]);
});

test('新規テストと破損時間も一度だけ割り当て、空集合は空とする', () => {
  const bins = assignTests(['a', 'new', 'b'], { a: Number.NaN, b: -1 }, 7);
  expect(bins.flat().toSorted()).toStrictEqual(['a', 'b', 'new']);
  expect(bins.every((bin) => bin.length > 0)).toBeTruthy();
  expect(assignTests([], {}, 3)).toStrictEqual([]);
});
