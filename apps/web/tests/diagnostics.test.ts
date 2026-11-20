import { parseJson } from '@korekaite/api-contracts/json';
import { assert, afterEach, expect, test, vi } from 'vitest';
import {
  validateCheckInternalError,
  validateCheckValidationError,
  validateCheckAccepted,
} from '@korekaite/api-contracts/http/diagnostics-validators';
import { acceptCheck } from '../src/diagnostics/accept';
import type { CheckDependencies } from '../src/diagnostics/accept';
import { getCheck } from '../src/diagnostics/get';

const repository = vi.hoisted(() => ({ acceptDiagnosticJob: vi.fn(), findDiagnosticJob: vi.fn() }));
vi.mock('../src/server/repositories/diagnostic-jobs', () => repository);
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

test('予期しない内部例外は詳細を公開せず500と追跡ログを返す', async () => {
  repository.acceptDiagnosticJob.mockRejectedValue(new TypeError('private_internal_failure'));
  repository.findDiagnosticJob.mockRejectedValue(new TypeError('private_internal_failure'));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {
    /* このテストでは呼出しに副作用を持たせない。 */
  });
  const deps: CheckDependencies = {
    // repositoryを置き換えるこの例外境界テストではDBを呼ばない。ローカルD1障害は統合テストで検証する。
    db: {} as CheckDependencies['db'],
    environment: 'test',
    actorId: 'local-developer',
    now: () => 1_793_577_600_000,
    newId: () => crypto.randomUUID(),
  };
  const start = new Request('http://localhost/api/diagnostics/check-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: '{"scenario":"success"}',
  });
  const responses = [
    await acceptCheck(start, deps),
    await getCheck(new Request('http://localhost'), crypto.randomUUID(), deps),
  ];
  for (const response of responses) {
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = parseJson(await response.text());
    assert.ok(validateCheckInternalError(body));
    expect(JSON.stringify(body)).not.toContain('private_internal_failure');
    expect(JSON.stringify(log.mock.calls)).toContain(body.error.requestId);
  }
  expect(JSON.stringify(log.mock.calls)).not.toContain('private_internal_failure');
});

test.each(['読取失敗', '不正JSON'])('本文が%sの要求は保存せず400と追跡情報を返す', async (kind) => {
  const requestId = crypto.randomUUID();
  const log = vi.spyOn(console, 'info').mockImplementation(() => {
    /* このテストでは呼出しに副作用を持たせない。 */
  });
  const deps: CheckDependencies = {
    db: {} as CheckDependencies['db'],
    environment: 'test',
    actorId: 'local-developer',
    now: () => 1_793_577_600_000,
    newId: () => requestId,
  };
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    duplex: 'half',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body:
      kind === '不正JSON'
        ? '{'
        : new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error('private_body_read_failure'));
            },
          }),
  };
  const response = await acceptCheck(
    new Request('http://localhost/api/diagnostics/check-jobs', init),
    deps,
  );
  expect(response.status).toBe(400);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = parseJson(await response.text());
  assert.ok(validateCheckValidationError(body));
  expect(body.error).toMatchObject({
    code: 'VALIDATION_ERROR',
    requestId,
    details: [{ location: 'body', path: '', code: 'INVALID_FORMAT' }],
  });
  expect(repository.acceptDiagnosticJob).not.toHaveBeenCalled();
  expect(JSON.stringify(body)).not.toContain('private_body_read_failure');
  expect(JSON.stringify(log.mock.calls)).toContain(requestId);
  expect(JSON.stringify(log.mock.calls)).not.toContain('private_body_read_failure');
});

test('永続化後の初期化開始に失敗しても202と元の受付を保持する', async () => {
  const requestId = crypto.randomUUID();
  const accepted = {
    jobId: crypto.randomUUID(),
    scenario: 'success',
    acceptedAt: '2026-11-03T00:00:00.000Z',
  };
  repository.acceptDiagnosticJob.mockResolvedValue(accepted);
  const scheduleInitialization = vi.fn(() => {
    throw new Error('private_initialization_failure');
  });
  const log = vi.spyOn(console, 'info').mockImplementation(() => {
    /* このテストでは呼出しに副作用を持たせない。 */
  });
  const deps: CheckDependencies = {
    db: {} as CheckDependencies['db'],
    environment: 'test',
    actorId: 'local-developer',
    now: () => 1_793_577_600_000,
    newId: () => requestId,
    scheduleInitialization,
  };
  const key = crypto.randomUUID();
  const request = new Request('http://localhost/api/diagnostics/check-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: '{"scenario":"success"}',
  });
  const response = await acceptCheck(request, deps);
  expect(response.status).toBe(202);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Location')).toBe(`/api/diagnostics/check-jobs/${accepted.jobId}`);
  const body = parseJson(await response.text());
  assert.ok(validateCheckAccepted(body));
  expect(body).toEqual(accepted);
  expect(repository.acceptDiagnosticJob).toHaveBeenCalledExactlyOnceWith(deps, key, {
    scenario: 'success',
  });
  expect(scheduleInitialization).toHaveBeenCalledExactlyOnceWith(accepted.jobId);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({
      event: 'diagnostic_initialization_deferred',
      requestId,
      jobId: accepted.jobId,
    }),
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain('private_initialization_failure');
});
