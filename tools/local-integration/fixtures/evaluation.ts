import type { JobNotification } from '@korekaite/api-contracts/messages';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { db, eq } from 'void/db';
import { connectionChecks, diagnosticChecks } from '@korekaite/database';
import { createPrimaryDb } from '@korekaite/database/connection';
import type { D1Database } from '@cloudflare/workers-types';
import { consumeJob } from '../../../apps/evaluation/src/application/consume-job';
import { evaluateDiagnostic } from '../../../apps/evaluation/src/diagnostics/evaluator';
import {
  acquireExecution,
  completeExecution,
  renewExecution,
  recoverExpiredExecution,
  type ExecutionLease,
} from '../../../apps/evaluation/src/server/repositories/job-execution';

export class TopologyEvaluation extends WorkerEntrypoint<{ DB: D1Database; APP_ENV: string }> {
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
  async evaluate(notification: JobNotification, hold = false, now?: number) {
    if (this.env.APP_ENV !== 'test') throw new Error('テスト環境専用です。');
    const primary = createPrimaryDb(this.env.DB);
    return consumeJob(
      notification,
      {
        queueName: 'test-rpc',
        messageId: crypto.randomUUID(),
        expectedPurpose: 'diagnostics',
        kind: 'normal',
      },
      {
        db: primary,
        now: () => now ?? Date.now(),
        newId: () => crypto.randomUUID(),
        evaluate: async (jobId, attemptNumber) => {
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
  messages: { id: string; body: JobNotification }[];
}) {
  for (const message of batch.messages) {
    if (!validateJobNotification(message.body))
      throw new Error('接続検証で通知契約違反を検知しました。');
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
