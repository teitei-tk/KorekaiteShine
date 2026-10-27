import { expect, it } from 'vitest';
import {
  HISTORY_SUMMARY_CHARS,
  HISTORY_UNCERTAINTIES,
  HISTORY_UNCERTAINTY_CHARS,
} from './output-size.ts';
it('履歴回答の説明の長さを指定する', () => {
  expect([HISTORY_SUMMARY_CHARS, HISTORY_UNCERTAINTIES, HISTORY_UNCERTAINTY_CHARS]).toEqual([
    300, 3, 150,
  ]);
});
