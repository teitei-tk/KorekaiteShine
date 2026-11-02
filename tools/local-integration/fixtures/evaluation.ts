import { WorkerEntrypoint } from 'cloudflare:workers';
import { db } from 'void/db';
import { connectionChecks } from '@korekaite/database';

export class TopologyEvaluation extends WorkerEntrypoint {
  async writeShared() {
    await db
      .insert(connectionChecks)
      .values({ writer: 'evaluation', value: 'shared' })
      .onConflictDoNothing();
  }
}

export default {
  async scheduled(controller: { cron: string }) {
    await db.insert(connectionChecks).values({ writer: 'scheduled', value: controller.cron });
  },
};
