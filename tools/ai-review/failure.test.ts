import { expect, it } from 'vitest';
import { failureReasons, validFailureReason } from './failure.ts';
import { failureMessage } from './failure-message.ts';

it('資料不足の未完了は不足する資料の確認を促す固定文にする', () => {
  expect(failureMessage('INCOMPLETE', 'MISSING_CONTEXT')).toContain('判断に必要な資料が足りない');
  expect(failureMessage('INCOMPLETE', 'MISSING_CONTEXT')).toContain('実装・呼び出し元・仕様');
});

it('公開する失敗理由は固定の列挙だけを受け付け自由文や欠損を拒否する', () => {
  for (const reason of failureReasons) {
    expect(validFailureReason(reason)).toBe(true);
  }
  expect(validFailureReason(undefined)).toBe(false);
  expect(validFailureReason('private details')).toBe(false);
});
