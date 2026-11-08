import type { MessageBatch } from '@cloudflare/workers-types';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import {
  createEvaluationWorker,
  type EvaluationEnvironment,
} from '../../../apps/evaluation/src/worker';

const worker = createEvaluationWorker({
  generate: async (input) => {
    if (
      !input.fragments.some((fragment) => fragment.speaker === 'user' && fragment.content.trim())
    ) {
      throw new Error('回答なしでAIを呼んではいけません。');
    }
    if (input.interview.themeExcerpt !== '架空の経験' || input.evaluation.model !== 'mock') {
      throw new Error('固定されたテスト入力ではありません。');
    }
    const axis = {
      status: 'unconfirmed',
      score: null,
      reason: 'この軸は架空の評価で未確認とします。',
      evidence: [],
    };
    return {
      summary: '架空の評価では各軸を未確認とします。',
      axes: { problem: axis, alternatives: axis, reasoning: axis, action: axis, learning: axis },
      strengths: [],
      gaps: [],
      unconfirmed: [],
      practiceQuestions: [],
      consistency: [],
    };
  },
});

export async function consumeFormalForTest(
  batch: MessageBatch<JobNotification>,
  env: EvaluationEnvironment & { APP_ENV: string },
): Promise<void> {
  if (env.APP_ENV !== 'test') {
    throw new Error('AI代替は独立test環境専用です。');
  }
  await worker.queue(batch, env);
}
