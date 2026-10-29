import { expect, it } from 'vitest';
import { lifecyclePassed } from './lifecycle.ts';

it.each([
  ['complete', 'success', 1, true, 'offline fixture complete', true],
  ['reject', 'failure', 1, true, '', true],
  ['complete', 'failure', 1, true, '', false],
  ['reject', 'success', 1, true, '', false],
  ['complete', 'success', 0, true, 'offline fixture complete', false],
  ['reject', 'failure', 0, true, '', false],
  ['complete', 'success', 1, false, 'offline fixture complete', false],
  ['complete', 'success', 1, true, 'unexpected output', false],
] as const)(
  'モデルなしの%s検証は起動・転送・結果が揃った時だけ合格する',
  (mode, outcome, count, authOk, output, expected) => {
    expect(lifecyclePassed(mode, outcome, { count, authOk }, output)).toBe(expected);
  },
);
