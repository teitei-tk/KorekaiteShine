import type { Queue } from '@cloudflare/workers-types';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import { DurableObject } from 'cloudflare:workers';
import { db } from 'void/db';
import { connectionChecks } from '@korekaite/database';

export class TopologyObject extends DurableObject<{
  APP_ENV: string;
  EVALUATION_QUEUE: Queue<JobNotification>;
}> {
  async writeIsolationMarker(marker: string) {
    if (
      this.env.APP_ENV !== 'test' ||
      !validateJobNotification({ schemaVersion: 1, jobId: marker })
    ) {
      throw new Error('テスト要求が不正です。');
    }
    await this.ctx.storage.put('isolation-marker', marker);
  }

  async readIsolationMarker() {
    if (this.env.APP_ENV !== 'test') {
      throw new Error('テスト環境専用です。');
    }
    return (await this.ctx.storage.get<string>('isolation-marker')) ?? null;
  }

  async enqueueFormalForTest(notification: JobNotification) {
    if (this.env.APP_ENV !== 'test' || !validateJobNotification(notification)) {
      throw new Error('テスト要求が不正です。');
    }
    await this.env.EVALUATION_QUEUE.send(notification);
    return { enqueued: true };
  }

  async writeShared() {
    await db
      .insert(connectionChecks)
      .values({ writer: 'interview', value: 'shared' })
      .onConflictDoNothing();
  }

  async probe() {
    await this.ctx.storage.put('probe', 'interview-do');
    return { saved: await this.ctx.storage.get<string>('probe'), environment: this.env.APP_ENV };
  }
}

export default {};
