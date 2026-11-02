import { DurableObject } from 'cloudflare:workers';
import { db } from 'void/db';
import { connectionChecks } from '@korekaite/database';

export class TopologyObject extends DurableObject<{ APP_ENV: string }> {
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
