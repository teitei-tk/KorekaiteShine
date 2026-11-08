import { Temporal } from '@js-temporal/polyfill';
import type { D1Database, Message, Queue } from '@cloudflare/workers-types';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import { createPrimaryDb } from '@korekaite/database/connection';
import { consumeJob } from './application/consume-job';
import {
  dispatchNotifications,
  type NotificationDependencies,
} from './application/dispatch-notifications';
import { recoverExecutions } from './application/recover-executions';
import { recoverOverdueNotifications } from './server/repositories/outbox';
import { isQuarantinedDelivery } from './server/repositories/delivery-anomalies';
import { createJobEvaluator } from './server/evaluate-job';
import { createInterviewEvaluator } from './server/openai-interview-evaluator';
import type { EvaluationGenerator } from './application/evaluate-interview';

export interface EvaluationEnvironment {
  DB: D1Database;
  EVALUATION_QUEUE_NAME: string;
  EVALUATION_DLQ_NAME: string;
  EVALUATION_QUEUE: Pick<Queue<JobNotification>, 'send'>;
  EVALUATION_DLQ: Pick<Queue<JobNotification>, 'send'>;
  OPENAI_API_KEY?: string;
}
interface EvaluationBatch {
  queue: string;
  messages: readonly Pick<Message<JobNotification>, 'id' | 'body' | 'ack' | 'retry'>[];
}

export function createEvaluationWorker(
  options: {
    now?: () => number;
    newId?: () => string;
    generate?: EvaluationGenerator;
  } = {},
) {
  const now = options.now ?? (() => Temporal.Now.instant().epochMilliseconds);
  const newId = options.newId ?? (() => crypto.randomUUID());
  function notifications(env: EvaluationEnvironment): NotificationDependencies {
    return {
      database: env.DB,
      now,
      sendNotification: async (purpose, operation, notification, delaySeconds) => {
        if (purpose !== 'evaluation') {
          throw new Error('評価以外の配送は扱いません。');
        }
        const target = operation === 'notify' ? env.EVALUATION_QUEUE : env.EVALUATION_DLQ;
        await target.send(notification, { delaySeconds });
      },
    };
  }
  return {
    async queue(batch: EvaluationBatch, env: EvaluationEnvironment): Promise<void> {
      if (
        !env.EVALUATION_QUEUE_NAME ||
        !env.EVALUATION_DLQ_NAME ||
        env.EVALUATION_QUEUE_NAME === env.EVALUATION_DLQ_NAME ||
        (batch.queue !== env.EVALUATION_QUEUE_NAME && batch.queue !== env.EVALUATION_DLQ_NAME)
      ) {
        for (const message of batch.messages) {
          message.retry({ delaySeconds: 30 });
        }
        return;
      }
      const kind: 'normal' | 'dlq' = batch.queue === env.EVALUATION_QUEUE_NAME ? 'normal' : 'dlq';
      const db = createPrimaryDb(env.DB);
      const evaluate = createJobEvaluator(
        db,
        options.generate ?? createInterviewEvaluator({ apiKey: env.OPENAI_API_KEY ?? '', now }),
        now,
      );
      for (const message of batch.messages) {
        const context = {
          queueName: batch.queue,
          messageId: message.id,
          expectedPurpose: 'evaluation' as const,
          kind,
        };
        const decision = await consumeJob(message.body, context, { db, now, newId, evaluate });
        if (decision.action === 'retry') {
          message.retry({ delaySeconds: decision.delaySeconds });
          continue;
        }
        try {
          if (
            validateJobNotification(message.body) &&
            !(await isQuarantinedDelivery(db, context))
          ) {
            await dispatchNotifications(notifications(env), {
              jobId: message.body.jobId,
              includeFuture: true,
              expectedPurpose: 'evaluation',
              operation: kind === 'dlq' ? 'notify' : undefined,
            });
          }
        } catch {
          // 保存済みの送信待ちは定期回復が再配送する。
          console.info(
            JSON.stringify({ event: 'evaluation_dispatch_deferred', messageId: message.id }),
          );
        }
        message.ack();
      }
    },
    async scheduled(_controller: object, env: EvaluationEnvironment): Promise<void> {
      await recoverExecutions(env.DB, now);
      await recoverOverdueNotifications(createPrimaryDb(env.DB), now());
      await dispatchNotifications(notifications(env), {
        includeFuture: true,
        expectedPurpose: 'evaluation',
      });
    },
  };
}

export default createEvaluationWorker();
