import type { D1Database, ScheduledController } from '@cloudflare/workers-types';
import { recoverInitializations } from './application/recover-initialization';

interface RecoveryEnvironment {
  DB: D1Database;
  APP_ENV: string;
  CHECK_OBJECT: {
    getByName(name: string): {
      initializeCheck(jobId: string): Promise<{ jobId: string; firstReceivedAt: string }>;
    };
  };
}

export default {
  async scheduled(_controller: ScheduledController, env: RecoveryEnvironment): Promise<void> {
    if (env.APP_ENV !== 'development' && env.APP_ENV !== 'test')
      throw new Error('診断回復を利用できない環境です。');
    await recoverInitializations(env.DB, async (jobId) => {
      await env.CHECK_OBJECT.getByName(`${env.APP_ENV}:diagnostics:${jobId}`).initializeCheck(
        jobId,
      );
    });
  },
};
