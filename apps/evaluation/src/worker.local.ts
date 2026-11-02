import { createPrimaryDb } from '@korekaite/database/connection';
import { isQuarantinedDelivery } from './server/repositories/delivery-anomalies';
import {
  dispatchNotifications,
  type NotificationDependencies,
} from './application/dispatch-notifications';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import { consumeDiagnostic } from './diagnostics/consume';
import type {
  D1Database,
  ScheduledController,
  MessageBatch,
  Queue,
} from '@cloudflare/workers-types';
import { recoverJobs } from './application/recover-jobs';

interface RecoveryEnvironment {
  DB: D1Database;
  APP_ENV: string;
  DIAGNOSTIC_QUEUE_NAME: string;
  DIAGNOSTIC_DLQ_NAME: string;
  DIAGNOSTIC_QUEUE: Queue<JobNotification>;
  DIAGNOSTIC_DLQ: Queue<JobNotification>;
  EVALUATION_QUEUE: Queue<JobNotification>;
  EVALUATION_DLQ: Queue<JobNotification>;
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
      const kind = batch.queue === env.DIAGNOSTIC_QUEUE_NAME ? 'normal' : 'dlq';
      if (batch.queue !== env.DIAGNOSTIC_QUEUE_NAME && batch.queue !== env.DIAGNOSTIC_DLQ_NAME) {
        message.retry({ delaySeconds: 30 });
        continue;
      }
      const decision = await consumeDiagnostic(
        message.body,
        {
          queueName: batch.queue,
          messageId: message.id,
          expectedPurpose: 'diagnostics',
          kind,
        },
        env.DB,
      );
      if (decision.action === 'ack') {
        if (kind === 'normal' && validateJobNotification(message.body)) {
          try {
            if (
              !(await isQuarantinedDelivery(createPrimaryDb(env.DB), {
                queueName: batch.queue,
                messageId: message.id,
              }))
            ) {
              await dispatchNotifications(notificationDependencies(env), {
                jobId: message.body.jobId,
                includeFuture: true,
                expectedPurpose: 'diagnostics',
              });
            }
          } catch {
            console.info(
              JSON.stringify({
                event: 'notification_dispatch_deferred',
                jobId: message.body.jobId,
              }),
            );
          }
        }
        message.ack();
      } else message.retry({ delaySeconds: decision.delaySeconds });
    }
  },
  async scheduled(_controller: ScheduledController, env: RecoveryEnvironment): Promise<void> {
    if (env.APP_ENV !== 'development' && env.APP_ENV !== 'test')
      throw new Error('診断回復を利用できない環境です。');
    await recoverJobs({
      ...notificationDependencies(env),
      initialize: async (jobId) => {
        await env.CHECK_OBJECT.getByName(`${env.APP_ENV}:diagnostics:${jobId}`).initializeCheck(
          jobId,
        );
      },
    });
  },
};

function notificationDependencies(env: RecoveryEnvironment): NotificationDependencies {
  return {
    database: env.DB,
    now: () => Date.now(),
    sendNotification: async (purpose, operation, notification, delaySeconds) => {
      const target =
        purpose === 'diagnostics'
          ? operation === 'notify'
            ? env.DIAGNOSTIC_QUEUE
            : env.DIAGNOSTIC_DLQ
          : operation === 'notify'
            ? env.EVALUATION_QUEUE
            : env.EVALUATION_DLQ;
      await target.send(notification, { delaySeconds });
    },
  };
}
