import type { JobNotification } from '@korekaite/api-contracts/messages';
import { consumeDiagnostic } from './diagnostics/consume';
import type { D1Database, ScheduledController, MessageBatch } from '@cloudflare/workers-types';
import { recoverInitializations } from './application/recover-initialization';
import { recoverExecutions } from './application/recover-executions';

interface RecoveryEnvironment {
  DB: D1Database;
  APP_ENV: string;
  DIAGNOSTIC_QUEUE_NAME: string;
  CHECK_OBJECT: {
    getByName(name: string): {
      initializeCheck(jobId: string): Promise<{ jobId: string; firstReceivedAt: string }>;
    };
  };
}

export default {
  async queue(batch: MessageBatch<JobNotification>, env: RecoveryEnvironment): Promise<void> {
    if (env.APP_ENV !== 'development' && env.APP_ENV !== 'test')
      throw new Error('診断評価を利用できない環境です。');
    for (const message of batch.messages) {
      if (batch.queue !== env.DIAGNOSTIC_QUEUE_NAME) {
        message.retry({ delaySeconds: 30 });
        continue;
      }
      const decision = await consumeDiagnostic(
        message.body,
        {
          queueName: batch.queue,
          messageId: message.id,
          expectedPurpose: 'diagnostics',
          kind: 'normal',
        },
        env.DB,
      );
      if (decision.action === 'ack') message.ack();
      else message.retry({ delaySeconds: decision.delaySeconds });
    }
  },
  async scheduled(_controller: ScheduledController, env: RecoveryEnvironment): Promise<void> {
    if (env.APP_ENV !== 'development' && env.APP_ENV !== 'test')
      throw new Error('診断回復を利用できない環境です。');
    await recoverExecutions(env.DB);
    await recoverInitializations(env.DB, async (jobId) => {
      await env.CHECK_OBJECT.getByName(`${env.APP_ENV}:diagnostics:${jobId}`).initializeCheck(
        jobId,
      );
    });
  },
};
