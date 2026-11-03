import type { JobNotification } from '@korekaite/api-contracts/messages';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { db, eq } from 'void/db';
import { connectionChecks, diagnosticChecks } from '@korekaite/database';
import { createPrimaryDb } from '@korekaite/database/connection';
import type { D1Database, Queue } from '@cloudflare/workers-types';
import { consumeJob } from '../../../apps/evaluation/src/application/consume-job';
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
  DIAGNOSTIC_QUEUE: Queue<JobNotification>;
  DIAGNOSTIC_DLQ: Queue<JobNotification>;
}> {
  async enqueueForTest(notification: JobNotification, kind: 'normal' | 'dlq') {
    if (this.env.APP_ENV !== 'test') throw new Error('テスト環境専用です。');
    await (kind === 'dlq' ? this.env.DIAGNOSTIC_DLQ : this.env.DIAGNOSTIC_QUEUE).send(notification);
    return { enqueued: true };
  }
  async acquireForTest(notification: JobNotification, now: number) {
    if (this.env.APP_ENV !== 'test' || !validateJobNotification(notification))
      throw new Error('テスト要求が不正です。');
    return acquireExecution(
      createPrimaryDb(this.env.DB),
      notification.jobId,
      'diagnostics',
      crypto.randomUUID(),
      now,
    );
  }
  async recoverForTest(notification: JobNotification, now: number) {
    if (this.env.APP_ENV !== 'test' || !validateJobNotification(notification))
      throw new Error('テスト要求が不正です。');
    return recoverExpiredExecution(
      createPrimaryDb(this.env.DB),
      notification.jobId,
      'diagnostics',
      crypto.randomUUID(),
      now,
    );
  }
  async renewForTest(lease: ExecutionLease, now: number) {
    if (this.env.APP_ENV !== 'test') throw new Error('テスト環境専用です。');
    return renewExecution(createPrimaryDb(this.env.DB), lease, now);
  }
  async completeForTest(lease: ExecutionLease, now: number) {
    if (this.env.APP_ENV !== 'test') throw new Error('テスト環境専用です。');
    return completeExecution(createPrimaryDb(this.env.DB), lease, { summary: '期限検証' }, now);
  }
  async evaluate(
    notification: JobNotification,
    hold = false,
    now?: number,
    messageId?: string,
    kind: 'normal' | 'dlq' = 'normal',
  ) {
    if (this.env.APP_ENV !== 'test') throw new Error('テスト環境専用です。');
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
        now: () => now ?? Date.now(),
        newId: () => crypto.randomUUID(),
        evaluate: async (jobId, attemptNumber) => {
          try {
            await primary.insert(connectionChecks).values({
              writer: `evaluation-call:${jobId}:${crypto.randomUUID()}`,
              value: String(attemptNumber),
            });
            if (hold) {
              const deadline = Date.now() + 15_000;
              for (;;) {
                const [released] = await primary
                  .select()
                  .from(connectionChecks)
                  .where(eq(connectionChecks.writer, `release:${jobId}`));
                if (released) break;
                if (Date.now() >= deadline)
                  throw new Error('テストの評価待機がタイムアウトしました。');
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
            }
            const [check] = await primary
              .select()
              .from(diagnosticChecks)
              .where(eq(diagnosticChecks.jobId, jobId));
            if (!check) throw new Error('診断条件がありません。');
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
    if (!validateJobNotification(message.body)) continue;
    if (message.attempts !== undefined) {
      await db
        .insert(connectionChecks)
        .values({
          writer: `queue-attempt:${batch.queue}:${message.id}:${message.attempts}`,
          value: JSON.stringify({
            messageId: message.id,
            attempt: message.attempts,
            receivedAt: Date.now(),
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
    for (const message of batch.messages) message.ack();
  },
  async scheduled(controller: { cron: string }) {
    await db
      .insert(connectionChecks)
      .values({ writer: 'scheduled', value: controller.cron })
      .onConflictDoUpdate({ target: connectionChecks.writer, set: { value: controller.cron } });
  },
};
