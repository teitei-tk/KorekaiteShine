import { consumeDlq } from './consume-dlq';
import { classifyDelivery } from './classify-delivery';
import {
  recordDeliveryAnomaly,
  refreshRecordedAnomaly,
} from '../server/repositories/delivery-anomalies';
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
  try {
    if (await refreshRecordedAnomaly(deps.db, context, deps.now())) {
      return { action: 'ack' };
    }
    if (!validateJobNotification(notification)) {
      const unsupportedVersion = validateJobNotification.errors?.some(
        (error) => error.instancePath === '/schemaVersion' && error.keyword === 'const',
      );
      await recordDeliveryAnomaly(
        deps.db,
        context,
        {
          code: unsupportedVersion ? 'UNSUPPORTED_SCHEMA_VERSION' : 'INVALID_NOTIFICATION',
          schemaVersion: null,
          jobId: null,
          observedPurpose: null,
        },
        deps.now(),
      );
      return { action: 'ack' };
    }
    const classification = await classifyDelivery(deps.db, notification);
    if (classification.kind === 'missing' || classification.kind === 'deleted') {
      await recordDeliveryAnomaly(
        deps.db,
        context,
        {
          code: classification.kind === 'deleted' ? 'JOB_DELETED' : 'JOB_NOT_FOUND',
          schemaVersion: notification.schemaVersion,
          jobId: notification.jobId,
          observedPurpose: null,
        },
        deps.now(),
      );
      return { action: 'ack' };
    }
    if (classification.job.purpose !== context.expectedPurpose) {
      await recordDeliveryAnomaly(
        deps.db,
        context,
        {
          code: 'JOB_PURPOSE_MISMATCH',
          schemaVersion: notification.schemaVersion,
          jobId: notification.jobId,
          observedPurpose: classification.job.purpose,
        },
        deps.now(),
      );
      return { action: 'ack' };
    }
    if (context.kind === 'dlq') {
      return await consumeDlq(notification, context, deps);
    }
    const lease = await acquireExecution(
      deps.db,
      notification.jobId,
      context.expectedPurpose,
      deps.newId(),
      deps.now(),
    );
    if (!lease) {
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
    }
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
