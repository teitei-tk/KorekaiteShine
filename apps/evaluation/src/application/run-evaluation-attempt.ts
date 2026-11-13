import type { EvaluationResult } from '../domain/evaluation-result';
import { executionTiming } from '../domain/lease';

export interface AttemptDependencies {
  now(): number;
  deadline: number;
  evaluate(signal: AbortSignal): Promise<EvaluationResult>;
  renew(): Promise<boolean>;
  save(result: EvaluationResult): Promise<boolean>;
}

export async function runEvaluationAttempt(deps: AttemptDependencies): Promise<boolean> {
  if (deps.now() >= deps.deadline) {
    return false;
  }
  const controller = new AbortController();
  const { promise: cancelled, resolve: cancel } = Promise.withResolvers<false>();
  const execution = { stopped: false };
  const stop = () => {
    execution.stopped = true;
    controller.abort();
    cancel(false);
  };
  const timers = {
    heartbeat: undefined as ReturnType<typeof setTimeout> | undefined,
    saveRetryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    endSaveWait: undefined as (() => void) | undefined,
  };
  const renew = async () => {
    if (deps.now() >= deps.deadline) {
      return stop();
    }
    try {
      if (!(await deps.renew())) {
        return stop();
      }
    } catch {
      return stop();
    }
    if (!execution.stopped) {
      timers.heartbeat = setTimeout(renew, executionTiming.renewalIntervalMs);
    }
  };
  timers.heartbeat = setTimeout(renew, executionTiming.renewalIntervalMs);
  const deadlineTimer = setTimeout(stop, deps.deadline - deps.now());
  const { promise: timeout, resolve: expire } = Promise.withResolvers<EvaluationResult>();
  const aiTimer = setTimeout(() => {
    expire({ ok: false, error: { code: 'AI_TIMEOUT', retryable: true } });
    controller.abort();
  }, executionTiming.aiTimeoutMs);
  const evaluate = async (): Promise<EvaluationResult> => {
    try {
      return await Promise.race([deps.evaluate(controller.signal), timeout]);
    } catch {
      return { ok: false, error: { code: 'AI_EXCEPTION', retryable: true } };
    }
  };
  const execute = async () => {
    const result = await evaluate();
    clearTimeout(aiTimer);
    while (!execution.stopped && deps.now() < deps.deadline) {
      try {
        return await deps.save(result);
      } catch {
        if (execution.stopped || deps.now() >= deps.deadline) {
          return false;
        }
        await new Promise<void>((resolve) => {
          timers.endSaveWait = resolve;
          timers.saveRetryTimer = setTimeout(
            resolve,
            Math.min(executionTiming.saveRetryIntervalMs, deps.deadline - deps.now()),
          );
        });
      }
    }
    return false;
  };
  try {
    return await Promise.race([execute(), cancelled]);
  } finally {
    execution.stopped = true;
    clearTimeout(aiTimer);
    clearTimeout(timers.heartbeat);
    clearTimeout(deadlineTimer);
    clearTimeout(timers.saveRetryTimer);
    timers.endSaveWait?.();
    controller.abort();
  }
}
