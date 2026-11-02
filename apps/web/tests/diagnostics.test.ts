import { afterEach, expect, test, vi } from 'vitest';
import { validateCheckInternalError } from '@korekaite/api-contracts/http/diagnostics-validators';
import { acceptCheck, type CheckDependencies } from '../src/diagnostics/accept';
import { getCheck } from '../src/diagnostics/get';

const repository = vi.hoisted(() => ({ acceptDiagnosticJob: vi.fn(), findDiagnosticJob: vi.fn() }));
vi.mock('../src/server/repositories/diagnostic-jobs', () => repository);
afterEach(() => vi.restoreAllMocks());

test('予期しない内部例外は詳細を公開せず500と追跡ログを返す', async () => {
  repository.acceptDiagnosticJob.mockRejectedValue(new TypeError('private_internal_failure'));
  repository.findDiagnosticJob.mockRejectedValue(new TypeError('private_internal_failure'));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const deps: CheckDependencies = {
    // repositoryを置き換えるこの例外境界テストではDBを呼ばない。実D1障害は統合テストで検証する。
    db: {} as CheckDependencies['db'],
    environment: 'test',
    actorId: 'local-developer',
    now: () => 1793577600000,
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
    const body = await response.json();
    expect(validateCheckInternalError(body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('private_internal_failure');
    expect(JSON.stringify(log.mock.calls)).toContain(body.error.requestId);
  }
  expect(JSON.stringify(log.mock.calls)).not.toContain('private_internal_failure');
});
