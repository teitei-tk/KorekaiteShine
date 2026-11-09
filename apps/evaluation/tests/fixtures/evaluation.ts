import type { EvaluationSnapshot } from '@korekaite/database';
export const snapshot: EvaluationSnapshot = {
  schemaVersion: 1,
  interview: {
    interviewId: 'interview',
    materialHash: 'hash',
    themeTitle: '構成',
    themeHeading: '判断',
    themeExcerpt: '架空の経験',
    background: '',
    activeMs: 1000,
  },
  fragments: [
    {
      fragmentId: 'f1',
      interviewId: 'interview',
      sequence: 1,
      generation: 1,
      sourceEventId: 'e1',
      speaker: 'user',
      content: '制約を比較しました。',
      sourceStartMs: 0,
      sourceEndMs: 1000,
      receivedAt: 10,
    },
  ],
  playback: [],
  transcriptIncomplete: false,
  evaluation: {
    model: 'test-model',
    promptVersion: 'v1',
    rubricVersion: 'v1',
    instructions: '根拠だけで評価する。',
    rubric: '架空の評価基準',
  },
};
export function result() {
  const axis = { status: 'unconfirmed', score: null, reason: '未質問です。', evidence: [] };
  return {
    summary: '制約について説明した。',
    axes: {
      problem: {
        status: 'scored',
        score: 2,
        reason: '比較内容の説明が不足している。',
        evidence: [{ source: 'transcript', fragmentIds: ['f1'], quote: '制約を比較しました。' }],
      },
      alternatives: axis,
      reasoning: axis,
      action: axis,
      learning: axis,
    },
    strengths: [],
    gaps: [],
    unconfirmed: [],
    practiceQuestions: [],
    consistency: [],
  };
}
