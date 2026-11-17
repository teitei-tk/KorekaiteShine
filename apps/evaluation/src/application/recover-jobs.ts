import { createPrimaryDb } from '@korekaite/database/connection';
import { recoverOverdueNotifications } from '../server/repositories/outbox';
import { recoverExecutions } from './recover-executions';
import { recoverInitializations } from './recover-initialization';
import { dispatchNotifications } from './dispatch-notifications';
import type { NotificationDependencies, RecoverySummary } from './dispatch-notifications';

export type { RecoverySummary } from './dispatch-notifications';
export type RecoveryDependencies = {
  initialize: (jobId: string) => Promise<void>;
} & NotificationDependencies;
export async function recoverJobs(deps: RecoveryDependencies): Promise<RecoverySummary> {
  await recoverExecutions(deps.database, deps.now);
  await recoverInitializations(deps.database, deps.initialize, deps.now);
  await recoverOverdueNotifications(createPrimaryDb(deps.database), deps.now());
  return dispatchNotifications(deps, { includeFuture: true });
}
