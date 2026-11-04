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
  let stopped = false;
  let stop = () => controller.abort();
  const cancelled = new Promise<false>((resolve) => {
    stop = () => {
      stopped = true;
      controller.abort();
      resolve(false);
    };
  });
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let saveRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let endSaveWait: (() => void) | undefined;
  const renew = async () => {
    if (stopped) {
      return;
    }
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
    if (!stopped) {
      heartbeat = setTimeout(renew, executionTiming.renewalIntervalMs);
    }
  };
  heartbeat = setTimeout(renew, executionTiming.renewalIntervalMs);
  const deadlineTimer = setTimeout(stop, deps.deadline - deps.now());
  let aiTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<EvaluationResult>((resolve) => {
    aiTimer = setTimeout(() => {
      resolve({ ok: false, error: { code: 'AI_TIMEOUT', retryable: true } });
      controller.abort();
    }, executionTiming.aiTimeoutMs);
  });
  const execute = async () => {
    let result: EvaluationResult;
    try {
      result = await Promise.race([deps.evaluate(controller.signal), timeout]);
    } catch {
      result = { ok: false, error: { code: 'AI_EXCEPTION', retryable: true } };
    }
    clearTimeout(aiTimer);
    while (!stopped && deps.now() < deps.deadline) {
      try {
        return await deps.save(result);
      } catch {
        if (stopped || deps.now() >= deps.deadline) {
          return false;
        }
        await new Promise<void>((resolve) => {
          endSaveWait = resolve;
          saveRetryTimer = setTimeout(
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
    stopped = true;
    clearTimeout(aiTimer);
    clearTimeout(heartbeat);
    clearTimeout(deadlineTimer);
    clearTimeout(saveRetryTimer);
    endSaveWait?.();
    controller.abort();
  }
}
