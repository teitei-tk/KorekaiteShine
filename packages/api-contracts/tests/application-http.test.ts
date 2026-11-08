import { expect, test } from 'vitest';
import {
  validateInterviewHistoryQuery,
  validateLocalSession,
  validateInterviewHistory,
  validateInterviewDetail,
} from '../generated/http/application-validators.mjs';

test('ローカル操作トークンと正式な履歴・詳細の形式を検証する', () => {
  expect(validateLocalSession({ operationToken: 'a'.repeat(64) })).toBe(true);
  expect(validateLocalSession({ operationToken: '' })).toBe(false);
  expect(validateInterviewHistory({ items: [], next: null })).toBe(true);
  expect(validateInterviewDetail({ session: { interviewId: 'one' } })).toBe(false);
});

test('履歴カーソルの型と範囲を契約から検証する', () => {
  expect(validateInterviewHistoryQuery({})).toBe(true);
  expect(validateInterviewHistoryQuery({ beforeCreatedAt: 123, beforeId: 'item-1' })).toBe(true);
  for (const value of [
    { beforeCreatedAt: -1 },
    { beforeCreatedAt: '123' },
    { beforeCreatedAt: 1.5 },
    { beforeId: '../item' },
    { extra: true },
  ]) {
    expect(validateInterviewHistoryQuery(value)).toBe(false);
  }
});
