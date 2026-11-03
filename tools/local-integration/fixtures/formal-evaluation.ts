import type { D1Database, MessageBatch } from '@cloudflare/workers-types';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import { createPrimaryDb } from '@korekaite/database/connection';
import { consumeJob } from '../../../apps/evaluation/src/application/consume-job';

export async function consumeFormalForTest(
  batch: MessageBatch<JobNotification>,
  env: {
    DB: D1Database;
    APP_ENV: string;
    EVALUATION_QUEUE_NAME: string;
    EVALUATION_DLQ_NAME: string;
  },
): Promise<void> {
  if (env.APP_ENV !== 'test') throw new Error('正式経路の架空評価はtest環境専用です。');
  if (batch.queue !== env.EVALUATION_QUEUE_NAME && batch.queue !== env.EVALUATION_DLQ_NAME)
    throw new Error('正式経路のQueueではありません。');
  for (const message of batch.messages) {
    const decision = await consumeJob(
      message.body,
      {
        queueName: batch.queue,
        messageId: message.id,
        expectedPurpose: 'evaluation',
        kind: batch.queue === env.EVALUATION_QUEUE_NAME ? 'normal' : 'dlq',
      },
      {
        db: createPrimaryDb(env.DB),
        now: () => Date.now(),
        newId: () => crypto.randomUUID(),
        evaluate: async () => ({ ok: true, value: { summary: '正式経路の接続検証用の架空評価' } }),
      },
    );
    if (decision.action === 'ack') message.ack();
    else message.retry({ delaySeconds: decision.delaySeconds });
  }
}
