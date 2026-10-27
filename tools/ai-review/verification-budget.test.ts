import { expect, test } from 'vitest';
import { maySpend } from './verification-budget.ts';

test('使用済み費用だけで上限を超えていたら拒否する', () => {
  expect(maySpend(1.1, 0.1)).toBe(false);
});
