import { deepStrictEqual } from 'node:assert';
import { test } from 'node:test';
import { cartTotal } from './cart.ts';

test('空・単一・複数の全明細を合計する', () => {
  deepStrictEqual(
    [
      cartTotal([]),
      cartTotal([{ quantity: 2, unitPrice: 100 }]),
      cartTotal([
        { quantity: 2, unitPrice: 100 },
        { quantity: 3, unitPrice: 50 },
      ]),
    ],
    [0, 200, 350],
  );
});
