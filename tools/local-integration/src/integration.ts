import { requireValue } from './required.ts';
import { parseJson } from '@korekaite/api-contracts/json';
import type { JsonValue } from '@korekaite/api-contracts/json';
import { startScheduledInterval } from './scheduled-interval.ts';
import { runtimeVersions } from './versions.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { components } from '@korekaite/api-contracts/http';
import {
  validateCheckAccepted,
  validateCheckStatus,
} from '@korekaite/api-contracts/http/diagnostics-validators';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand } from './runtime.ts';
import type { LocalRuntime } from './runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
type CheckStatus = components['schemas']['CheckStatus'];
type Outcome = Pick<CheckStatus, 'status' | 'attemptCount' | 'checks'>;
type Scenario = CheckStatus['scenario'];
type Fault =
  | 'response_loss'
  | 'after_acceptance'
  | 'after_do_save'
  | 'after_queue_send'
  | 'after_result_before_ack';
type NativeDeliveryAttempt = { messageId: string; attempt: number; receivedAt: number };
function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNativeDeliveryAttempt(value: JsonValue): value is NativeDeliveryAttempt {
  return (
    isJsonObject(value) &&
    typeof value.messageId === 'string' &&
    typeof value.attempt === 'number' &&
    Number.isSafeInteger(value.attempt) &&
    typeof value.receivedAt === 'number' &&
    Number.isSafeInteger(value.receivedAt)
  );
}

type ConsumerStop = { kind: 'exception'; messageId: string; occurredAt: number };
function isConsumerStop(value: JsonValue): value is ConsumerStop & { queue: string } {
  return (
    isJsonObject(value) &&
    value.kind === 'exception' &&
    typeof value.messageId === 'string' &&
    value.messageId.length > 0 &&
    typeof value.queue === 'string' &&
    typeof value.occurredAt === 'number' &&
    Number.isSafeInteger(value.occurredAt)
  );
}

type Attempt = { attemptNumber: number; startedAt: number; finishedAt: number };
function isAttempt(value: JsonValue): value is Attempt {
  return (
    isJsonObject(value) &&
    typeof value.attemptNumber === 'number' &&
    typeof value.startedAt === 'number' &&
    Number.isSafeInteger(value.startedAt) &&
    typeof value.finishedAt === 'number' &&
    Number.isSafeInteger(value.finishedAt)
  );
}

type DispatchState = { notifications: number; unsent: number; deliveries: number };
type AcceptanceCounts = { jobs: number; requests: number };

export type IntegrationReport = {
  environment: 'test';
  runId: string;
  parallelIndex: number;
  case: Scenario | Fault;
  restart?: { stoppedAt: number; restartedAt: number };
  mode: 'dev';
  clock: 'real';
  versions: Record<string, string>;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  timings: { startupMs: number; restartMs: number; checksMs: number; cleanupMs: number };
  expected: Outcome & { retryDelaysMs: number[]; acceptanceCounts?: AcceptanceCounts };
  attempts: { attemptNumber: number; startedAt: number; finishedAt: number }[];
  scheduled: {
    intervalMs: number;
    invocations: {
      startedAt: number;
      elapsedMs: number;
      completedAt: number | null;
      outcome: 'pending' | 'ok' | 'failed';
    }[];
  };
  actual: Partial<Outcome> & {
    jobId?: string;
    queueBeforeRestart?: boolean;
    queueRecovery?: 'd1_outbox' | 'native_retry';
    consumerStop?: ConsumerStop;
    acknowledgedAfterStop?: boolean;
    nativeDeliveryAttempts?: NativeDeliveryAttempt[];
    dispatchBeforeRestart?: DispatchState;
    dispatchAfterRestart?: DispatchState;
    initializationHttpStatus?: number;
    beforeRestartFirstReceivedAt?: number | null;
    doFirstReceivedAt?: number;
    faultObservedAt?: number;
    beforeRestartStatus?: CheckStatus['status'];
    beforeRestartChecks?: CheckStatus['checks'];
    restartCount?: number;
    responseDiscarded?: boolean;
    retryHttpStatus?: number;
    acceptanceBeforeRetry?: AcceptanceCounts;
    acceptanceAfterRetry?: AcceptanceCounts;
    startHttpStatus?: number;
    statusHttpStatus?: number;
    queue?: string;
    queueObserved?: boolean;
  };
  exitCode: 0 | 1 | null;
  failureCode?: string;
};

class IntegrationFailureError extends Error {
  readonly code: string;

  readonly recoveryTiming?: {
    restartedAt: number;
    scheduledStartedAt: number | null;
    scheduledElapsedMs: number | null;
    attemptStartedAt: number;
  };

  constructor(code: string, recoveryTiming?: IntegrationFailureError['recoveryTiming']) {
    super(`統合検証に失敗しました: ${code}`);
    this.name = 'IntegrationFailureError';
    this.code = code;
    this.recoveryTiming = recoveryTiming;
  }
}

async function discardAcceptanceResponse(url: string, key: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        // 本文を一度も読み取らず、クライアント側の接続を破棄する。
        response.destroy();
        // ClientRequestのresponseイベントではHTTP解析済みのstatusCodeが必ずある。
        // 不正なHTTP応答はresponseではなくrequestのerrorイベントへ進む。
        resolve(requireValue(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

async function acceptanceCounts(baseUrl: string): Promise<AcceptanceCounts> {
  const response = await fetch(`${baseUrl}/api/check-object-test?view=acceptance-counts`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = parseJson(await response.text());
  if (
    response.status !== 200 ||
    !isJsonObject(body) ||
    typeof body.jobs !== 'number' ||
    !Number.isSafeInteger(body.jobs) ||
    typeof body.requests !== 'number' ||
    !Number.isSafeInteger(body.requests)
  ) {
    throw new IntegrationFailureError('ACCEPTANCE_COUNTS_CONTRACT');
  }
  return { jobs: body.jobs, requests: body.requests };
}

async function firstReceivedAt(baseUrl: string, jobId: string): Promise<number | null> {
  const response = await fetch(`${baseUrl}/api/check-object-test?view=persistence&jobId=${jobId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = parseJson(await response.text());
  if (
    response.status !== 200 ||
    !isJsonObject(body) ||
    !(
      body.firstReceivedAt === null ||
      (typeof body.firstReceivedAt === 'number' && Number.isSafeInteger(body.firstReceivedAt))
    )
  ) {
    throw new IntegrationFailureError('PERSISTENCE_CONTRACT');
  }
  return body.firstReceivedAt;
}

async function dispatchState(baseUrl: string, jobId: string): Promise<DispatchState> {
  const response = await fetch(`${baseUrl}/api/check-object-test?view=dispatch&jobId=${jobId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = parseJson(await response.text());
  if (
    response.status !== 200 ||
    !isJsonObject(body) ||
    typeof body.notifications !== 'number' ||
    typeof body.unsent !== 'number' ||
    typeof body.deliveries !== 'number' ||
    ![body.notifications, body.unsent, body.deliveries].every((value) =>
      Number.isSafeInteger(value),
    )
  ) {
    throw new IntegrationFailureError('DISPATCH_CONTRACT');
  }
  return { notifications: body.notifications, unsent: body.unsent, deliveries: body.deliveries };
}

async function waitForNativeRetry(
  baseUrl: string,
  jobId: string,
  queue: string,
): Promise<{
  stop: ConsumerStop;
  deliveries: NativeDeliveryAttempt[];
}> {
  const deadline = performance.now() + 90_000;
  for (;;) {
    const response = await fetch(`${baseUrl}/api/check-object-test?view=ack-stop&jobId=${jobId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = parseJson(await response.text());
    if (
      response.status !== 200 ||
      !isJsonObject(body) ||
      !Array.isArray(body.deliveries) ||
      !body.deliveries.every((value) => isNativeDeliveryAttempt(value))
    ) {
      throw new IntegrationFailureError('NATIVE_RETRY_CONTRACT');
    }
    const { stop } = body;
    if (stop !== null && (!isConsumerStop(stop) || stop.queue !== queue)) {
      throw new IntegrationFailureError('NATIVE_RETRY_CONTRACT');
    }
    if (
      isConsumerStop(stop) &&
      body.acknowledgedMessageId === stop.messageId &&
      body.deliveries.length >= 2
    ) {
      const deliveries: NativeDeliveryAttempt[] = body.deliveries.map((entry) => ({
        messageId: entry.messageId,
        attempt: entry.attempt,
        receivedAt: entry.receivedAt,
      }));
      if (
        deliveries.length !== 2 ||
        deliveries.some(
          (entry, index) => entry.messageId !== stop.messageId || entry.attempt !== index + 1,
        ) ||
        deliveries[1].receivedAt - deliveries[0].receivedAt < 30_000 ||
        stop.occurredAt > deliveries[1].receivedAt
      ) {
        throw new IntegrationFailureError('NATIVE_RETRY_MISMATCH');
      }
      return {
        stop: { kind: 'exception', messageId: stop.messageId, occurredAt: stop.occurredAt },
        deliveries,
      };
    }
    if (performance.now() >= deadline) {
      throw new IntegrationFailureError('NATIVE_RETRY_TIMEOUT');
    }
    await delay(250);
  }
}

export async function runDiagnosticScenario(input: {
  runId: string;
  parallelIndex: number;
  scenario: Scenario;
  fault?: Fault;
}): Promise<{ report: IntegrationReport; resultPath: string }> {
  const restarts =
    input.fault === 'after_acceptance' ||
    input.fault === 'after_do_save' ||
    input.fault === 'after_queue_send';
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: input.runId,
    parallelIndex: input.parallelIndex,
  });
  const directory = dirname(config.artifactDirectory);
  const resultPath = join(directory, 'results.json');
  const started = performance.now();
  const report: IntegrationReport = {
    environment: 'test',
    runId: input.runId,
    parallelIndex: input.parallelIndex,
    case: input.fault ?? input.scenario,
    mode: 'dev',
    clock: 'real',
    versions: { node: process.version },
    startedAt: Temporal.Now.instant().toString({ fractionalSecondDigits: 3 }),
    finishedAt: null,
    durationMs: null,
    timings: { startupMs: 0, restartMs: 0, checksMs: 0, cleanupMs: 0 },
    expected: {
      ...(input.fault === 'response_loss' ? { acceptanceCounts: { jobs: 1, requests: 1 } } : {}),
      status: input.scenario === 'exhaust_retries' ? 'failed' : 'completed',
      attemptCount:
        input.scenario === 'success' ? 1 : input.scenario === 'retry_then_success' ? 2 : 4,
      retryDelaysMs:
        input.scenario === 'success'
          ? []
          : input.scenario === 'retry_then_success'
            ? [30_000]
            : [30_000, 120_000, 300_000],
      checks: {
        doPersistence: 'passed',
        consumerCompletion: input.scenario === 'exhaust_retries' ? 'not_expected' : 'passed',
        dlqReceipt: input.scenario === 'exhaust_retries' ? 'passed' : 'not_expected',
      },
    },
    actual: {},
    attempts: [],
    scheduled: { intervalMs: 60_000, invocations: [] },
    exitCode: null,
  };
  await mkdir(directory, { recursive: true });
  // 同じ実行ID/番号の証拠を、並行実行や再実行で上書きしない。
  await writeFile(resultPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  const runtimeContext = {
    runtime: undefined as LocalRuntime | undefined,
    failure: undefined as Error | undefined,
    stopScheduled: undefined as (() => void) | undefined,
    scheduledPending: undefined as Promise<void> | undefined,
    scheduledFailed: false,
  };
  const measure = async <T>(
    phase: 'startupMs' | 'restartMs' | 'cleanupMs',
    operation: () => Promise<T>,
  ): Promise<T> => {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      report.timings[phase] += performance.now() - started;
    }
  };
  const hasScheduledFailed = () => runtimeContext.scheduledFailed;
  function startScheduled(activeRuntime: LocalRuntime): void {
    runtimeContext.stopScheduled = startScheduledInterval((elapsedMs) => {
      if (runtimeContext.scheduledPending || runtimeContext.scheduledFailed) {
        return;
      }
      const invocation: IntegrationReport['scheduled']['invocations'][number] = {
        startedAt: Temporal.Now.instant().epochMilliseconds,
        elapsedMs,
        completedAt: null,
        outcome: 'pending',
      };
      report.scheduled.invocations.push(invocation);
      runtimeContext.scheduledPending = activeRuntime
        .runScheduled(AbortSignal.timeout(10_000))
        .then(() => {
          invocation.outcome = 'ok';
          return undefined;
        })
        .catch(() => {
          invocation.outcome = 'failed';
          runtimeContext.scheduledFailed = true;
        })
        .finally(() => {
          invocation.completedAt = Temporal.Now.instant().epochMilliseconds;
          runtimeContext.scheduledPending = undefined;
        });
    }, report.scheduled.intervalMs);
  }
  try {
    runtimeContext.runtime = await measure('startupMs', async () => {
      report.versions = await runtimeVersions();
      return startRuntime(config, 'dev', {
        manualDiagnostics: restarts,
        holdEvaluationBeforeConsume: input.fault === 'after_queue_send',
        stopAfterResultBeforeAck: input.fault === 'after_result_before_ack',
      });
    });
    if (!restarts) {
      startScheduled(runtimeContext.runtime);
    }
    const acceptanceUrl = `${runtimeContext.runtime.baseUrl}/api/diagnostics/check-jobs`;
    const idempotencyKey = randomUUID();
    const requestBody = JSON.stringify({ scenario: input.scenario });
    if (input.fault === 'response_loss') {
      report.actual.startHttpStatus = await discardAcceptanceResponse(
        acceptanceUrl,
        idempotencyKey,
        requestBody,
      );
      report.actual.responseDiscarded = true;
      if (report.actual.startHttpStatus !== 202) {
        throw new IntegrationFailureError('ACCEPTANCE_CONTRACT');
      }
      report.actual.acceptanceBeforeRetry = await acceptanceCounts(runtimeContext.runtime.baseUrl);
      if (
        !isDeepStrictEqual(report.actual.acceptanceBeforeRetry, report.expected.acceptanceCounts)
      ) {
        throw new IntegrationFailureError('ACCEPTANCE_COUNTS_MISMATCH');
      }
    }
    const acceptedResponse = await fetch(acceptanceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: requestBody,
      signal: AbortSignal.timeout(10_000),
    });
    if (input.fault === 'response_loss') {
      report.actual.retryHttpStatus = acceptedResponse.status;
    } else {
      report.actual.startHttpStatus = acceptedResponse.status;
    }
    const accepted = parseJson(await acceptedResponse.text());
    if (
      acceptedResponse.status !== 202 ||
      !validateCheckAccepted(accepted) ||
      accepted.scenario !== input.scenario
    ) {
      throw new IntegrationFailureError('ACCEPTANCE_CONTRACT');
    }
    report.actual.jobId = accepted.jobId;
    if (input.fault === 'after_do_save' || input.fault === 'after_queue_send') {
      await runDatabaseCommand(config, [
        'execute',
        input.fault === 'after_do_save'
          ? "CREATE TRIGGER reject_integration_notification BEFORE INSERT ON job_outbox WHEN NEW.operation = 'notify' BEGIN SELECT RAISE(FAIL, 'simulated_outbox_failure'); END;"
          : "CREATE TRIGGER reject_integration_notification BEFORE UPDATE OF sent_at ON job_outbox WHEN OLD.operation = 'notify' BEGIN SELECT RAISE(FAIL, 'simulated_sent_failure'); END;",
      ]);
      const initialization = await fetch(
        `${runtimeContext.runtime.baseUrl}/api/check-object-test`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: accepted.jobId }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      report.actual.initializationHttpStatus = initialization.status;
      await initialization.text();
      report.actual.faultObservedAt = Temporal.Now.instant().epochMilliseconds;
      if (initialization.status !== 500) {
        throw new IntegrationFailureError('FAULT_NOT_OBSERVED');
      }
      report.actual.beforeRestartFirstReceivedAt = await firstReceivedAt(
        runtimeContext.runtime.baseUrl,
        accepted.jobId,
      );
      if (input.fault === 'after_do_save' && report.actual.beforeRestartFirstReceivedAt !== null) {
        throw new IntegrationFailureError('RESTART_BOUNDARY_MISMATCH');
      }
    }
    if (input.fault === 'after_queue_send') {
      const receivedBy = performance.now() + 10_000;
      for (;;) {
        const receipt = await fetch(
          `${runtimeContext.runtime.baseUrl}/api/check-object-test?jobId=${accepted.jobId}`,
          { signal: AbortSignal.timeout(10_000) },
        );
        const body = parseJson(await receipt.text());
        if (
          receipt.status === 200 &&
          isJsonObject(body) &&
          validateJobNotification(body.message) &&
          body.message.jobId === accepted.jobId &&
          body.queue === config.queues.diagnostics?.queue
        ) {
          break;
        }
        if (performance.now() >= receivedBy) {
          throw new IntegrationFailureError('QUEUE_RECEIPT_TIMEOUT');
        }
        await delay(100);
      }
      report.actual.queueBeforeRestart = true;
      report.actual.dispatchBeforeRestart = await dispatchState(
        runtimeContext.runtime.baseUrl,
        accepted.jobId,
      );
      if (
        !isDeepStrictEqual(report.actual.dispatchBeforeRestart, {
          notifications: 1,
          unsent: 1,
          deliveries: 1,
        })
      ) {
        throw new IntegrationFailureError('RESTART_BOUNDARY_MISMATCH');
      }
    }
    if (restarts) {
      const beforeResponse = await fetch(
        `${runtimeContext.runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`,
        {
          signal: AbortSignal.timeout(10_000),
        },
      );
      const before = parseJson(await beforeResponse.text());
      if (
        beforeResponse.status !== 200 ||
        !validateCheckStatus(before) ||
        before.jobId !== accepted.jobId ||
        before.status !== 'pending' ||
        before.attemptCount !== 0 ||
        before.checks.doPersistence !==
          (input.fault === 'after_queue_send' ? 'passed' : 'pending') ||
        before.checks.consumerCompletion !== 'pending'
      ) {
        throw new IntegrationFailureError('RESTART_BOUNDARY_MISMATCH');
      }
      report.actual.beforeRestartStatus = before.status;
      report.actual.beforeRestartChecks = before.checks;
      await measure('restartMs', async () => {
        await requireValue(runtimeContext.runtime).stop();
        runtimeContext.runtime = undefined;
        const stoppedAt = Temporal.Now.instant().epochMilliseconds;
        if (input.fault === 'after_do_save' || input.fault === 'after_queue_send') {
          await runDatabaseCommand(config, [
            'execute',
            'DROP TRIGGER reject_integration_notification;',
          ]);
        }
        runtimeContext.runtime = await startRuntime(config);
        report.restart = { stoppedAt, restartedAt: Temporal.Now.instant().epochMilliseconds };
      });
      report.actual.restartCount = 1;
      startScheduled(runtimeContext.runtime);
    }
    const deadline =
      performance.now() +
      (input.scenario === 'exhaust_retries' ? 600_000 : restarts ? 120_000 : 60_000);
    for (;;) {
      if (hasScheduledFailed()) {
        throw new IntegrationFailureError('SCHEDULED_FAILED');
      }
      const response = await fetch(
        `${runtimeContext.runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      report.actual.statusHttpStatus = response.status;
      const status = parseJson(await response.text());
      if (
        response.status !== 200 ||
        !validateCheckStatus(status) ||
        status.jobId !== accepted.jobId ||
        status.scenario !== input.scenario
      ) {
        throw new IntegrationFailureError('STATUS_CONTRACT');
      }
      report.actual.status = status.status;
      report.actual.attemptCount = status.attemptCount;
      report.actual.checks = status.checks;
      if (
        status.status === 'completed' ||
        (status.status === 'failed' &&
          (input.scenario !== 'exhaust_retries' || status.checks.dlqReceipt === 'passed')) ||
        status.status === 'cancelled'
      ) {
        break;
      }
      if (performance.now() >= deadline) {
        throw new IntegrationFailureError('TIMEOUT');
      }
      await delay(250);
    }
    if (
      report.actual.status !== report.expected.status ||
      report.actual.attemptCount !== report.expected.attemptCount ||
      !isDeepStrictEqual(report.actual.checks, report.expected.checks)
    ) {
      throw new IntegrationFailureError('OUTCOME_MISMATCH');
    }
    if (input.fault === 'after_result_before_ack') {
      const retried = await waitForNativeRetry(
        runtimeContext.runtime.baseUrl,
        accepted.jobId,
        requireValue(config.queues.diagnostics).queue,
      );
      report.actual.consumerStop = retried.stop;
      report.actual.nativeDeliveryAttempts = retried.deliveries;
      report.actual.acknowledgedAfterStop = true;
      report.actual.queueRecovery = 'native_retry';
      report.actual.beforeRestartStatus = report.actual.status;
      report.actual.beforeRestartChecks = report.actual.checks;
      runtimeContext.stopScheduled?.();
      await runtimeContext.scheduledPending;
      if (hasScheduledFailed()) {
        throw new IntegrationFailureError('SCHEDULED_FAILED');
      }
      await measure('restartMs', async () => {
        await requireValue(runtimeContext.runtime).stop();
        runtimeContext.runtime = undefined;
        const stoppedAt = Temporal.Now.instant().epochMilliseconds;
        runtimeContext.runtime = await startRuntime(config);
        report.restart = { stoppedAt, restartedAt: Temporal.Now.instant().epochMilliseconds };
      });
      report.actual.restartCount = 1;
      const afterResponse = await fetch(
        `${runtimeContext.runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const after = parseJson(await afterResponse.text());
      if (
        afterResponse.status !== 200 ||
        !validateCheckStatus(after) ||
        after.jobId !== accepted.jobId ||
        after.scenario !== input.scenario ||
        after.status !== report.expected.status ||
        after.attemptCount !== report.expected.attemptCount ||
        !isDeepStrictEqual(after.checks, report.expected.checks)
      ) {
        throw new IntegrationFailureError('RESTART_RESULT_MISMATCH');
      }
      report.actual.statusHttpStatus = afterResponse.status;
      report.actual.status = after.status;
      report.actual.attemptCount = after.attemptCount;
      report.actual.checks = after.checks;
    }
    // 観測専用GETで、Consumerの直接呼出しではなく実Queue配送だったことを確認する。
    const receiptResponse = await fetch(
      `${runtimeContext.runtime.baseUrl}/api/check-object-test?jobId=${accepted.jobId}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const receipt = parseJson(await receiptResponse.text());
    if (
      receiptResponse.status !== 200 ||
      !isJsonObject(receipt) ||
      !validateJobNotification(receipt.message) ||
      receipt.message.jobId !== accepted.jobId ||
      typeof receipt.queue !== 'string' ||
      receipt.queue !==
        (input.scenario === 'exhaust_retries'
          ? config.queues.diagnostics?.dlq
          : config.queues.diagnostics?.queue)
    ) {
      throw new IntegrationFailureError('QUEUE_RECEIPT_MISMATCH');
    }
    report.actual.queue = receipt.queue;
    report.actual.queueObserved = true;
    const attemptsResponse = await fetch(
      `${runtimeContext.runtime.baseUrl}/api/check-object-test?jobId=${accepted.jobId}&view=attempts`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
    const attempts = parseJson(await attemptsResponse.text());
    if (
      attemptsResponse.status !== 200 ||
      !Array.isArray(attempts) ||
      attempts.length !== report.expected.attemptCount ||
      !attempts.every((value) => isAttempt(value)) ||
      attempts.some(
        (attempt, index) =>
          attempt.attemptNumber !== index + 1 ||
          attempt.startedAt < Temporal.Instant.from(accepted.acceptedAt).epochMilliseconds ||
          attempt.finishedAt < attempt.startedAt,
      )
    ) {
      throw new IntegrationFailureError('ATTEMPT_HISTORY');
    }
    report.attempts = attempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
    }));
    for (const [index, next] of report.attempts.slice(1).entries()) {
      const elapsed = next.startedAt - report.attempts[index].finishedAt;
      if (elapsed < report.expected.retryDelaysMs[index]) {
        throw new IntegrationFailureError('RETRY_TOO_EARLY');
      }
    }
    if (input.fault === 'response_loss') {
      report.actual.acceptanceAfterRetry = await acceptanceCounts(runtimeContext.runtime.baseUrl);
      if (
        !isDeepStrictEqual(report.actual.acceptanceAfterRetry, report.expected.acceptanceCounts)
      ) {
        throw new IntegrationFailureError('ACCEPTANCE_COUNTS_MISMATCH');
      }
    }
    if (restarts) {
      const first = report.scheduled.invocations.at(0);
      if (
        !first ||
        first.elapsedMs < report.scheduled.intervalMs ||
        report.attempts[0].startedAt < first.startedAt
      ) {
        // CIに成果物がなくても、どの時刻条件に違反したかを識別できる数値だけ残す。
        throw new IntegrationFailureError('RECOVERY_SCHEDULE_MISMATCH', {
          // 再起動経路では上でrestartを設定し、試行履歴も件数と形式を検証済み。
          restartedAt: requireValue(report.restart).restartedAt,
          scheduledStartedAt: first?.startedAt ?? null,
          scheduledElapsedMs: first?.elapsedMs ?? null,
          attemptStartedAt: report.attempts[0].startedAt,
        });
      }
    }
    if (input.fault === 'after_do_save' || input.fault === 'after_queue_send') {
      const persisted = await firstReceivedAt(runtimeContext.runtime.baseUrl, accepted.jobId);
      if (
        persisted === null ||
        persisted < Temporal.Instant.from(accepted.acceptedAt).epochMilliseconds ||
        persisted > requireValue(report.actual.faultObservedAt)
      ) {
        throw new IntegrationFailureError('DO_STATE_NOT_PRESERVED');
      }
      report.actual.doFirstReceivedAt = persisted;
    }
    if (input.fault === 'after_queue_send') {
      report.actual.dispatchAfterRestart = await dispatchState(
        runtimeContext.runtime.baseUrl,
        accepted.jobId,
      );
      const dispatched = report.actual.dispatchAfterRestart;
      if (dispatched.notifications !== 1 || dispatched.unsent !== 0 || dispatched.deliveries < 2) {
        throw new IntegrationFailureError('OUTBOX_RECOVERY_MISMATCH');
      }
      report.actual.queueRecovery = 'd1_outbox';
    }
    if (
      input.fault === 'after_result_before_ack' &&
      requireValue(report.attempts.at(-1)).finishedAt >
        requireValue(report.actual.consumerStop).occurredAt
    ) {
      throw new IntegrationFailureError('STOP_BEFORE_RESULT');
    }
    report.exitCode = 0;
  } catch (error) {
    runtimeContext.failure = error instanceof Error ? error : new Error('統合検証に失敗しました。');
    report.exitCode = 1;
    report.failureCode = error instanceof IntegrationFailureError ? error.code : 'UNEXPECTED_ERROR';
  } finally {
    await measure('cleanupMs', async () => {
      runtimeContext.stopScheduled?.();
      await runtimeContext.scheduledPending;
      if (hasScheduledFailed()) {
        runtimeContext.failure = new IntegrationFailureError('SCHEDULED_FAILED');
        report.exitCode = 1;
        report.failureCode = 'SCHEDULED_FAILED';
      }
      try {
        await runtimeContext.runtime?.stop();
        if (report.exitCode === 0) {
          // この関数はappEnv: 'test'で解決するため、ローカル状態の保存先が必ずある。
          await rm(requireValue(config.stateDirectory), { recursive: true, force: true });
          await rm(config.artifactDirectory, { recursive: true, force: true });
        }
      } catch (error) {
        runtimeContext.failure =
          error instanceof Error ? error : new Error('統合検証の停止・破棄に失敗しました。');
        report.exitCode = 1;
        report.failureCode = 'CLEANUP_FAILED';
      }
    });
    report.finishedAt = Temporal.Now.instant().toString({ fractionalSecondDigits: 3 });
    report.durationMs = performance.now() - started;
    report.timings.checksMs = Math.max(
      0,
      report.durationMs -
        report.timings.startupMs -
        report.timings.restartMs -
        report.timings.cleanupMs,
    );
    // 応答全体、要求本文、冪等キー、例外メッセージは記録しない。
    await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (runtimeContext.failure) {
    throw runtimeContext.failure;
  }
  return { report, resultPath };
}
