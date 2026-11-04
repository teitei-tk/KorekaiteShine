import { Temporal } from '@js-temporal/polyfill';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import { DurableObject } from 'cloudflare:workers';
import type { D1Database, Queue } from '@cloudflare/workers-types';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import {
  requireDiagnosticInitialization,
  confirmDiagnosticInitialization,
  pendingCheckNotification,
  markCheckNotificationSent,
} from '../server/repositories/check-outbox';

interface CheckBindings {
  DB: D1Database;
  APP_ENV: string;
  DIAGNOSTIC_QUEUE: Queue<JobNotification>;
}
export interface CheckInitialized {
  jobId: string;
  firstReceivedAt: string;
}

export class CheckObject extends DurableObject<CheckBindings> {
  async initializeCheck(jobId: string): Promise<CheckInitialized> {
    if (this.env.APP_ENV !== 'development' && this.env.APP_ENV !== 'test') {
      throw new Error('診断DOを利用できない環境です。');
    }
    if (!validateJobNotification({ schemaVersion: 1, jobId })) {
      throw new Error('診断ジョブIDが不正です。');
    }
    const receivedAt = Temporal.Now.instant().toString({ fractionalSecondDigits: 3 });
    await requireDiagnosticInitialization(this.env.DB, jobId);
    const initialized = await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<CheckInitialized>('initialization');
      if (existing) {
        if (existing.jobId !== jobId) {
          throw new Error('DOとジョブの対応が一致しません。');
        }
        return existing;
      }
      const saved = { jobId, firstReceivedAt: receivedAt };
      await transaction.put('initialization', saved);
      return saved;
    });
    const persisted = await this.ctx.storage.get<CheckInitialized>('initialization');
    if (
      !persisted ||
      persisted.jobId !== initialized.jobId ||
      persisted.firstReceivedAt !== initialized.firstReceivedAt
    ) {
      throw new Error('DOの保存結果を確認できません。');
    }
    await confirmDiagnosticInitialization(
      this.env.DB,
      jobId,
      Temporal.Instant.from(persisted.firstReceivedAt).epochMilliseconds,
    );
    const pending = await pendingCheckNotification(this.env.DB, jobId);
    if (pending) {
      const notification = { schemaVersion: 1, jobId: pending.jobId };
      if (!validateJobNotification(notification)) {
        throw new Error('通知契約を満たしていません。');
      }
      await this.env.DIAGNOSTIC_QUEUE.send(notification);
      await markCheckNotificationSent(this.env.DB, pending.id);
    }
    return persisted;
  }
}
