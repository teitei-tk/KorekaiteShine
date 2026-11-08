import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, onTestFinished, vi } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { runDiagnosticScenario, type IntegrationReport } from '../../src/integration.ts';
import { startRuntime, type LocalRuntime } from '../../src/runtime.ts';
import { runtimeVersions } from '../../src/versions.ts';

type Input = Parameters<typeof runDiagnosticScenario>[0];
type Reply = () => Response | Promise<Response>;
const clock = vi.hoisted(() => ({ milliseconds: 0, httpStatus: 202 }));
vi.mock('../../src/runtime.ts', () => ({ startRuntime: vi.fn(), runDatabaseCommand: vi.fn() }));
vi.mock('../../src/versions.ts', () => ({ runtimeVersions: vi.fn() }));
vi.mock('node:timers/promises', () => ({
  setTimeout: async (milliseconds: number) => {
    clock.milliseconds += milliseconds;
    await vi.advanceTimersByTimeAsync(milliseconds);
  },
}));
vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  request: (
    _url: string,
    _options: object,
    callback: (response: { statusCode: number; destroy(): void }) => void,
  ) => {
    const request = {
      on: () => request,
      end: () => callback({ statusCode: clock.httpStatus, destroy: vi.fn() }),
    };
    return request;
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

/** 実際の契約検証器へ、制御したHTTP応答と時刻を入力する。実Worker検証とは別に使う。 */
export function scenarioFixture(scenario: Input['scenario'] = 'success', fault?: Input['fault']) {
  clock.milliseconds = 0;
  clock.httpStatus = 202;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const base = Temporal.Instant.from('2026-11-03T00:00:00.000Z').epochMilliseconds;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.milliseconds);
  vi.spyOn(Temporal.Now, 'instant').mockImplementation(() =>
    Temporal.Instant.fromEpochMilliseconds(base + clock.milliseconds),
  );
  const advance = async (milliseconds: number) => {
    clock.milliseconds += milliseconds;
    await vi.advanceTimersByTimeAsync(milliseconds);
  };
  const input: Input = { runId: randomUUID(), parallelIndex: 0, scenario, fault };
  const config = resolveRuntime({
    repositoryRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
    appEnv: 'test',
    runId: input.runId,
    parallelIndex: 0,
  });
  const directory = dirname(config.artifactDirectory);
  const resultPath = join(directory, 'results.json');
  onTestFinished(() => rm(dirname(directory), { recursive: true, force: true }));
  const runtime: LocalRuntime = {
    baseUrl: 'http://integration.invalid',
    closed: Promise.resolve({ exitCode: 0 }),
    stop: vi.fn(async () => {}),
    runScheduled: vi.fn(async () => {}),
  };
  vi.mocked(startRuntime).mockResolvedValue(runtime);
  vi.mocked(runtimeVersions).mockResolvedValue({ node: process.version });
  const jobId = randomUUID();
  const accepted = { jobId, scenario, acceptedAt: '2026-11-03T00:00:00.000Z' };
  const count = scenario === 'success' ? 1 : scenario === 'retry_then_success' ? 2 : 4;
  const completed = {
    ...accepted,
    status: scenario === 'exhaust_retries' ? 'failed' : 'completed',
    attemptCount: count,
    updatedAt: '2026-11-03T00:00:01.000Z',
    finishedAt: '2026-11-03T00:00:01.000Z',
    nextAttemptAt: null,
    lastErrorCode: null,
    checks: {
      doPersistence: 'passed',
      consumerCompletion: scenario === 'exhaust_retries' ? 'not_expected' : 'passed',
      dlqReceipt: scenario === 'exhaust_retries' ? 'passed' : 'not_expected',
    },
  };
  const restarts =
    fault === 'after_acceptance' || fault === 'after_do_save' || fault === 'after_queue_send';
  const pending = {
    ...completed,
    status: 'pending',
    attemptCount: 0,
    finishedAt: null,
    checks: {
      doPersistence: fault === 'after_queue_send' ? 'passed' : 'pending',
      consumerCompletion: 'pending',
      dlqReceipt: 'not_expected',
    },
  };
  let attemptStart = base + (restarts ? 60_000 : 0);
  const attempts = Array.from({ length: count }, (_, index) => {
    if (index > 0) {
      attemptStart += [30_000, 120_000, 300_000][index - 1]! + 1;
    }
    return { attemptNumber: index + 1, startedAt: attemptStart, finishedAt: attemptStart + 1 };
  });
  const receipt = {
    queue:
      scenario === 'exhaust_retries'
        ? config.queues.diagnostics!.dlq
        : config.queues.diagnostics!.queue,
    message: { schemaVersion: 1, jobId },
  };
  const nativeRetry = {
    stop: {
      kind: 'exception',
      messageId: 'delivery',
      queue: config.queues.diagnostics!.queue,
      occurredAt: base + 1000,
    },
    acknowledgedMessageId: 'delivery',
    deliveries: [
      { messageId: 'delivery', attempt: 1, receivedAt: base },
      { messageId: 'delivery', attempt: 2, receivedAt: base + 30_000 },
    ],
  };
  const replies: Record<
    | 'accept'
    | 'status'
    | 'receipt'
    | 'attempts'
    | 'counts'
    | 'persistence'
    | 'dispatch'
    | 'nativeRetry'
    | 'initialize',
    Reply
  > = {
    accept: () => Response.json(accepted, { status: 202 }),
    status: () =>
      Response.json(
        restarts &&
          (vi.mocked(startRuntime).mock.calls.length < 2 ||
            vi.mocked(runtime.runScheduled).mock.calls.length === 0)
          ? pending
          : completed,
      ),
    receipt: () => Response.json(receipt),
    attempts: () => Response.json(attempts),
    counts: () => Response.json({ jobs: 1, requests: 1 }),
    persistence: () =>
      Response.json({
        firstReceivedAt:
          vi.mocked(startRuntime).mock.calls.length >= 2 || fault === 'after_queue_send'
            ? base
            : null,
      }),
    dispatch: () =>
      Response.json(
        vi.mocked(startRuntime).mock.calls.length >= 2
          ? { notifications: 1, unsent: 0, deliveries: 2 }
          : { notifications: 1, unsent: 1, deliveries: 1 },
      ),
    nativeRetry: async () => {
      await advance(30_000);
      return Response.json(nativeRetry);
    },
    initialize: () => new Response('injected failure', { status: 500 }),
  };
  const fetcher = vi.fn<typeof fetch>(async (request, options) => {
    const url = new URL(String(request));
    if (url.pathname === '/api/diagnostics/check-jobs') {
      return replies.accept();
    }
    if (url.pathname === `/api/diagnostics/check-jobs/${jobId}`) {
      return replies.status();
    }
    if (url.pathname !== '/api/check-object-test') {
      throw new Error('想定外のfixture要求です。');
    }
    if (options?.method === 'POST') {
      return replies.initialize();
    }
    const view = url.searchParams.get('view');
    if (view === 'attempts') {
      return replies.attempts();
    }
    if (view === 'acceptance-counts') {
      return replies.counts();
    }
    if (view === 'persistence') {
      return replies.persistence();
    }
    if (view === 'dispatch') {
      return replies.dispatch();
    }
    if (view === 'ack-stop') {
      return replies.nativeRetry();
    }
    return replies.receipt();
  });
  vi.stubGlobal('fetch', fetcher);
  const readReport = async (): Promise<IntegrationReport> =>
    JSON.parse(await readFile(resultPath, 'utf8'));
  const fails = async (code: string, message: string = code) => {
    await expect(runDiagnosticScenario(input)).rejects.toThrow(message);
    const serialized = await readFile(resultPath, 'utf8');
    expect(serialized).not.toContain('private details');
    expect(JSON.parse(serialized)).toMatchObject({ exitCode: 1, failureCode: code });
    expect(vi.getTimerCount()).toBe(0);
    return readReport();
  };
  return {
    input,
    config,
    runtime,
    replies,
    fetcher,
    accepted,
    completed,
    pending,
    attempts,
    receipt,
    nativeRetry,
    base,
    advance,
    clock,
    readReport,
    fails,
    run: () => runDiagnosticScenario(input),
  };
}
