import type { JobNotification } from '@korekaite/api-contracts/messages';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { db, eq } from 'void/db';
import { connectionChecks } from '@korekaite/database';

export class TopologyEvaluation extends WorkerEntrypoint {
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

export default {
  // 接続確認専用Consumer。受信を記録し、評価の業務状態は変更しない。
  async queue(batch: { queue: string; messages: { body: JobNotification; ack(): void }[] }) {
    for (const message of batch.messages) {
      if (!validateJobNotification(message.body))
        throw new Error('接続検証で通知契約違反を検知しました。');
      const value = JSON.stringify({ queue: batch.queue, message: message.body });
      await db
        .insert(connectionChecks)
        .values({ writer: `queue:${message.body.jobId}`, value })
        .onConflictDoUpdate({ target: connectionChecks.writer, set: { value } });
      message.ack();
    }
  },
  async scheduled(controller: { cron: string }) {
    await db.insert(connectionChecks).values({ writer: 'scheduled', value: controller.cron });
  },
};
