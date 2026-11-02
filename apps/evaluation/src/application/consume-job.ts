import { runEvaluationAttempt } from './run-evaluation-attempt';
import type { EvaluationResult } from '../domain/evaluation-result';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import type { createPrimaryDb } from '@korekaite/database/connection';
import {
  acquireExecution,
  isTerminalJob,
  hasActiveExecution,
  deferForBusySlot,
  completeExecution,
  failExecution,
  renewExecution,
  type JobPurpose,
} from '../server/repositories/job-execution';

export type DeliveryDecision = { action: 'ack' } | { action: 'retry'; delaySeconds: 30 };
export interface DeliveryContext {
  queueName: string;
  messageId: string;
  expectedPurpose: JobPurpose;
  kind: 'normal' | 'dlq';
}
export interface EvaluationDependencies {
  db: ReturnType<typeof createPrimaryDb>;
  now(): number;
  newId(): string;
  evaluate(jobId: string, attemptNumber: number, signal: AbortSignal): Promise<EvaluationResult>;
}
export async function consumeJob(
  notification: JobNotification,
  context: DeliveryContext,
  deps: EvaluationDependencies,
): Promise<DeliveryDecision> {
  const retry = { action: 'retry', delaySeconds: 30 } as const;
  if (!validateJobNotification(notification) || context.kind !== 'normal') return retry;
  try {
    const lease = await acquireExecution(
      deps.db,
      notification.jobId,
      context.expectedPurpose,
      deps.newId(),
      deps.now(),
    );
    if (!lease)
      return (await isTerminalJob(deps.db, notification.jobId, context.expectedPurpose)) ||
        (await hasActiveExecution(
          deps.db,
          notification.jobId,
          context.expectedPurpose,
          deps.now(),
        )) ||
        (await deferForBusySlot(
          deps.db,
          notification.jobId,
          context.expectedPurpose,
          deps.newId(),
          deps.now(),
        ))
        ? { action: 'ack' }
        : retry;
    const saved = await runEvaluationAttempt({
      now: deps.now,
      deadline: lease.deadline,
      evaluate: (signal) => deps.evaluate(lease.jobId, lease.attemptNumber, signal),
      renew: () => renewExecution(deps.db, lease, deps.now()),
      save: (result) =>
        result.ok
          ? completeExecution(deps.db, lease, result.value, deps.now())
          : failExecution(deps.db, lease, result.error, deps.newId(), deps.now()),
    });
    return saved ? { action: 'ack' } : retry;
  } catch {
    return retry;
  }
}
