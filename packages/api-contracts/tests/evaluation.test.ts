import { expect, test } from 'vitest';
import { validateInterviewEvaluation } from '../generated/http/evaluation-validators.mjs';

test('五軸と引用を必須にし、未確認を0点や範囲外の点数に置換しない', () => {
  const axis = { status: 'unconfirmed', score: null, reason: 'まだ質問していない。', evidence: [] };
  const value = {
    summary: '課題を確認した。',
    axes: { problem: axis, alternatives: axis, reasoning: axis, action: axis, learning: axis },
    strengths: [],
    gaps: [],
    unconfirmed: [],
    practiceQuestions: [],
    consistency: [],
  };
  expect(validateInterviewEvaluation(value)).toBe(true);
  expect(
    validateInterviewEvaluation({
      ...value,
      axes: { ...value.axes, action: { ...axis, score: 0 } },
    }),
  ).toBe(false);
  expect(validateInterviewEvaluation({ ...value, axes: { problem: axis } })).toBe(false);
});
