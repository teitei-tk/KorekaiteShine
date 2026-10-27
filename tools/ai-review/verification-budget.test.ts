import { expect, test } from 'vitest';
import { maySpend } from './verification-budget.ts';

test('使用済み費用だけで上限を超えていたら拒否する', () => {
  expect(maySpend(1.1, 0.1)).toBe(false);
});

test('今回の費用を加えた上限超過は拒否し、ちょうど1ドルは許可する', () => {
  expect(maySpend(0.95, 0.1)).toBe(false);
  expect(maySpend(0.75, 0.25)).toBe(true);
});

test('負値と有限でない入力は拒否する', () => {
  for (const value of [-1, NaN, Infinity]) {
    expect(maySpend(value, 0.1)).toBe(false);
    expect(maySpend(0.1, value)).toBe(false);
  }
});
