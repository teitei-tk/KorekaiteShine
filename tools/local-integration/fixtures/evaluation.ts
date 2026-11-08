import { confirmFixtureKey } from './ai-bindings';
import { diagnosticTransactionEffects } from '../../../apps/evaluation/src/diagnostics/transaction-effects';
import { Temporal } from '@js-temporal/polyfill';
import { readAckStopHistoryForTest } from './ack-stop';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { db, eq } from 'void/db';
import {
  connectionChecks,
  diagnosticChecks,
  diagnosticRequests,
  jobAttempts,
  jobOutbox,
  jobs,
  dlqReceipts,
} from '@korekaite/database';
import { createPrimaryDb } from '@korekaite/database/connection';
import type { D1Database, Queue } from '@cloudflare/workers-types';
import { consumeJob } from '../../../apps/evaluation/src/application/consume-job';
import { dispatchNotifications } from '../../../apps/evaluation/src/application/dispatch-notifications';
import { evaluateDiagnostic } from '../../../apps/evaluation/src/diagnostics/evaluator';
import {
  acquireExecution,
  completeExecution,
  renewExecution,
  recoverExpiredExecution,
  type ExecutionLease,
} from '../../../apps/evaluation/src/server/repositories/job-execution';

export class TopologyEvaluation extends WorkerEntrypoint<{
  DB: D1Database;
  APP_ENV: string;
  OPENAI_API_KEY?: string;
  DIAGNOSTIC_QUEUE: Queue<JobNotification>;
  DIAGNOSTIC_DLQ: Queue<JobNotification>;
  EVALUATION_DLQ: Queue<JobNotification>;
}> {
  confirmFixtureKey(digest: string) {
    return confirmFixtureKey(this.env, digest);
  }

  async dispatchForTest(now: number, failJobId?: string) {
    if (
      this.env.APP_ENV !== 'test' ||
      !Number.isSafeInteger(now) ||
      (failJobId !== undefined && !validateJobNotification({ schemaVersion: 1, jobId: failJobId }))
    ) {
      throw new Error('テスト要求が不正です。');
    }
    const requests: {
      purpose: 'evaluation' | 'diagnostics';
      operation: 'notify' | 'notify_dlq';
      jobId: string;
      delaySeconds: number;
    }[] = [];
    const summary = await dispatchNotifications(
      {
        database: this.env.DB,
        now: () => now,
        async sendNotification(purpose, operation, notification, delaySeconds) {
          requests.push({ purpose, operation, jobId: notification.jobId, delaySeconds });
          if (notification.jobId === failJobId) {
            throw new Error('送信失敗の注入');
          }
        },
      },
      { includeFuture: true },
    );
    return { ...summary, requests };
  }

  async enqueueFormalDlqForTest(notification: JobNotification) {
    if (this.env.APP_ENV !== 'test' || !validateJobNotification(notification)) {
      throw new Error('テスト要求が不正です。');
    }
    await this.env.EVALUATION_DLQ.send(notification);
    return { enqueued: true };
  }

  async readFormalDlq(jobId: string) {
    if (this.env.APP_ENV !== 'test' || !validateJobNotification({ schemaVersion: 1, jobId })) {
      throw new Error('テスト要求が不正です。');
    }
    return createPrimaryDb(this.env.DB)
      .select({
        jobId: dlqReceipts.jobId,
        purpose: dlqReceipts.purpose,
        queueName: dlqReceipts.queueName,
        observedStatus: dlqReceipts.observedStatus,
      })
      .from(dlqReceipts)
      .where(eq(dlqReceipts.jobId, jobId));
  }

  async enqueueForTest(notification: JobNotification, kind: 'normal' | 'dlq') {
    if (this.env.APP_ENV !== 'test') {
      throw new Error('テスト環境専用です。');
    }
    await (kind === 'dlq' ? this.env.DIAGNOSTIC_DLQ : this.env.DIAGNOSTIC_QUEUE).send(notification);
    return { enqueued: true };
  }
  async acquireForTest(notification: JobNotification, now: number) {
    if (this.env.APP_ENV !== 'test' || !validateJobNotification(notification)) {
      throw new Error('テスト要求が不正です。');
    }
    return acquireExecution(
      createPrimaryDb(this.env.DB),
      notification.jobId,
      'diagnostics',
      crypto.randomUUID(),
      now,
    );
  }
  async recoverForTest(notification: JobNotification, now: number) {
    if (this.env.APP_ENV !== 'test' || !validateJobNotification(notification)) {
      throw new Error('テスト要求が不正です。');
    }
    return recoverExpiredExecution(
      createPrimaryDb(this.env.DB),
      notification.jobId,
      'diagnostics',
      crypto.randomUUID(),
      now,
    );
  }
  async renewForTest(lease: ExecutionLease, now: number) {
    if (this.env.APP_ENV !== 'test') {
      throw new Error('テスト環境専用です。');
    }
    return renewExecution(createPrimaryDb(this.env.DB), lease, now);
  }
  async completeForTest(lease: ExecutionLease, now: number) {
    if (this.env.APP_ENV !== 'test') {
      throw new Error('テスト環境専用です。');
    }
    return completeExecution(createPrimaryDb(this.env.DB), lease, { summary: '期限検証' }, now);
  }
  async evaluate(
    notification: JobNotification,
    hold = false,
    now?: number,
    messageId?: string,
    kind: 'normal' | 'dlq' = 'normal',
    rejectEvaluation = false,
  ) {
    if (this.env.APP_ENV !== 'test') {
      throw new Error('テスト環境専用です。');
    }
    const primary = createPrimaryDb(this.env.DB);
    return consumeJob(
      notification,
      {
        queueName: kind === 'dlq' ? 'test-dlq' : 'test-rpc',
        messageId: messageId ?? crypto.randomUUID(),
        expectedPurpose: 'diagnostics',
        kind,
      },
      {
        db: primary,
        effects: diagnosticTransactionEffects(primary),
        now: () => now ?? Temporal.Now.instant().epochMilliseconds,
        newId: () => crypto.randomUUID(),
        evaluate: async (jobId, attemptNumber) => {
          if (rejectEvaluation) {
            throw new Error('テスト専用の評価例外');
          }
          try {
            await primary.insert(connectionChecks).values({
              writer: `evaluation-call:${jobId}:${crypto.randomUUID()}`,
              value: String(attemptNumber),
            });
            if (hold) {
              const deadline = Temporal.Now.instant().epochMilliseconds + 15_000;
              for (;;) {
                const [released] = await primary
                  .select()
                  .from(connectionChecks)
                  .where(eq(connectionChecks.writer, `release:${jobId}`));
                if (released) {
                  break;
                }
                if (Temporal.Now.instant().epochMilliseconds >= deadline) {
                  throw new Error('テストの評価待機がタイムアウトしました。');
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
            }
            const [check] = await primary
              .select()
              .from(diagnosticChecks)
              .where(eq(diagnosticChecks.jobId, jobId));
            if (!check) {
              throw new Error('診断条件がありません。');
            }
            return evaluateDiagnostic(check.scenario, attemptNumber);
          } catch (error) {
            console.error(
              JSON.stringify({
                event: 'test_evaluation_error',
                message: error instanceof Error ? error.message.slice(0, 300) : 'non_error',
                cause:
                  error instanceof Error && error.cause instanceof Error
                    ? error.cause.message.slice(0, 300)
                    : null,
              }),
            );
            throw error;
          }
        },
      },
    );
  }
  async readQueueReceipt(jobId: string) {
    const [row] = await db
      .select()
      .from(connectionChecks)
      .where(eq(connectionChecks.writer, `queue:${jobId}`));
    return row ? JSON.parse(row.value) : null;
  }

  async readFormalJob(jobId: string) {
    if (this.env.APP_ENV !== 'test' || !validateJobNotification({ schemaVersion: 1, jobId })) {
      throw new Error('テスト要求が不正です。');
    }
    const [job] = await createPrimaryDb(this.env.DB)
      .select({
        jobId: jobs.jobId,
        purpose: jobs.purpose,
        status: jobs.status,
        attemptCount: jobs.attemptCount,
      })
      .from(jobs)
      .where(eq(jobs.jobId, jobId));
    return job ?? null;
  }

  async readAckStopHistory(jobId: string) {
    return readAckStopHistoryForTest(this.env, jobId);
  }

  async readDispatchState(jobId: string) {
    if (this.env.APP_ENV !== 'test' || !validateJobNotification({ schemaVersion: 1, jobId })) {
      throw new Error('テスト要求が不正です。');
    }
    const primary = createPrimaryDb(this.env.DB);
    const rows = await primary.select().from(jobOutbox).where(eq(jobOutbox.jobId, jobId));
    const notifications = rows.filter((row) => row.operation === 'notify');
    const receipts = await primary.select().from(connectionChecks);
    const deliveries = receipts
      .filter((row) => row.writer.startsWith('queue-message:'))
      .map((row) => JSON.parse(row.value))
      .filter((row) => row.message.jobId === jobId).length;
    return {
      notifications: notifications.length,
      unsent: notifications.filter((row) => row.sentAt === null).length,
      deliveries,
    };
  }

  async readInitializationPersistence(jobId: string) {
    if (this.env.APP_ENV !== 'test' || !validateJobNotification({ schemaVersion: 1, jobId })) {
      throw new Error('テスト要求が不正です。');
    }
    const [row] = await createPrimaryDb(this.env.DB)
      .select({ firstReceivedAt: diagnosticChecks.firstReceivedAt })
      .from(diagnosticChecks)
      .where(eq(diagnosticChecks.jobId, jobId));
    return row ?? null;
  }

  async readAcceptanceCounts() {
    if (this.env.APP_ENV !== 'test') {
      throw new Error('テスト環境専用です。');
    }
    const primary = createPrimaryDb(this.env.DB);
    const jobRows = await primary.select({ id: jobs.jobId }).from(jobs);
    const requestRows = await primary
      .select({ id: diagnosticRequests.id })
      .from(diagnosticRequests);
    return { jobs: jobRows.length, requests: requestRows.length };
  }

  async readJobAttempts(jobId: string | null) {
    if (
      this.env.APP_ENV !== 'test' ||
      typeof jobId !== 'string' ||
      !validateJobNotification({ schemaVersion: 1, jobId })
    ) {
      throw new Error('テスト要求が不正です。');
    }
    return createPrimaryDb(this.env.DB)
      .select({
        attemptNumber: jobAttempts.attemptNumber,
        startedAt: jobAttempts.startedAt,
        finishedAt: jobAttempts.finishedAt,
      })
      .from(jobAttempts)
      .where(eq(jobAttempts.jobId, jobId))
      .orderBy(jobAttempts.attemptNumber);
  }

  async writeShared() {
    await db
      .insert(connectionChecks)
      .values({ writer: 'evaluation', value: 'shared' })
      .onConflictDoNothing();
  }
}

export async function recordQueueDelivery(batch: {
  queue: string;
  messages: { id: string; body: JobNotification; attempts?: number }[];
}) {
  for (const message of batch.messages) {
    // 不正通知の判断は業務Consumerへ委ね、probeは本文を保存しない。
    if (!validateJobNotification(message.body)) {
      continue;
    }
    if (message.attempts !== undefined) {
      await db
        .insert(connectionChecks)
        .values({
          writer: `queue-attempt:${batch.queue}:${message.id}:${message.attempts}`,
          value: JSON.stringify({
            messageId: message.id,
            attempt: message.attempts,
            receivedAt: Temporal.Now.instant().epochMilliseconds,
          }),
        })
        .onConflictDoNothing();
    }
    const value = JSON.stringify({ queue: batch.queue, message: message.body });
    await db
      .insert(connectionChecks)
      .values({ writer: `queue-message:${batch.queue}:${message.id}`, value })
      .onConflictDoNothing();
    await db
      .insert(connectionChecks)
      .values({ writer: `queue:${message.body.jobId}`, value })
      .onConflictDoUpdate({ target: connectionChecks.writer, set: { value } });
  }
}

export default {
  // 接続確認専用Consumer。受信を記録し、評価の業務状態は変更しない。
  async queue(batch: {
    queue: string;
    messages: { id: string; body: JobNotification; ack(): void }[];
  }) {
    await recordQueueDelivery(batch);
    for (const message of batch.messages) {
      message.ack();
    }
  },
  async scheduled(controller: { cron: string }) {
    await db
      .insert(connectionChecks)
      .values({ writer: 'scheduled', value: controller.cron })
      .onConflictDoUpdate({ target: connectionChecks.writer, set: { value: controller.cron } });
  },
};

export async function holdBeforeEvaluationForTest(env: { APP_ENV: string }): Promise<never> {
  if (env.APP_ENV !== 'test') {
    throw new Error('評価前の停止はtest環境専用です。');
  }
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}
