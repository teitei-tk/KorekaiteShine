import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { interviewCases } from '../../../apps/web/tests/contracts/interviews.ts';
import {
  runHttpContractIntegration,
  runDiagnosticHttpContractIntegration,
} from '../src/http-contract.ts';

test('開発とビルド済みWorkerに一覧APIの全HTTP契約ケースを送り証拠を保存する', async () => {
  const results = await runHttpContractIntegration();
  expect(results.map((result) => result.mode)).toEqual(['dev', 'preview']);
  for (const result of results) {
    const report = JSON.parse(await readFile(result.resultPath, 'utf8'));
    expect(report).toMatchObject({
      environment: 'test',
      mode: result.mode,
      clock: 'real',
      exitCode: 0,
      case: 'interviews-http-contract',
      versions: { void: '1.5.0' },
    });
    expect(report.actual.cases).toEqual(
      interviewCases.map((example, index) => ({
        index,
        status: example.status,
        itemCount: example.count ?? null,
        contractValid: true,
      })),
    );
    expect(report.expected.cases).toHaveLength(interviewCases.length);
    await expect(access(join(dirname(result.resultPath), 'state'))).rejects.toThrow();
    await expect(access(join(dirname(result.resultPath), 'artifacts'))).rejects.toThrow();
  }
}, 180_000);

test('診断APIの正常・不正・競合・参照範囲・DB障害の契約が開発とビルド済みWorkerで一致する', async () => {
  const results = await runDiagnosticHttpContractIntegration();
  expect(results.map((result) => result.mode)).toEqual(['dev', 'preview']);
  const statuses = [
    400, 400, 400, 400, 400, 400, 400, 400, 415, 202, 202, 409, 200, 404, 404, 404, 500, 500, 503,
    503,
  ];
  for (const result of results) {
    const serialized = await readFile(result.resultPath, 'utf8');
    const report = JSON.parse(serialized);
    expect(report).toMatchObject({
      environment: 'test',
      mode: result.mode,
      exitCode: 0,
      case: 'diagnostics-http-contract',
      actual: {
        completedJob: {
          status: 'completed',
          attemptCount: 1,
          checks: {
            doPersistence: 'passed',
            consumerCompletion: 'passed',
            dlqReceipt: 'not_expected',
          },
        },
      },
    });
    expect(report.actual.cases.map((entry: { status: number }) => entry.status)).toEqual(statuses);
    expect(
      report.actual.cases.every(
        (entry: { contractValid: boolean; noStore: boolean }) =>
          entry.contractValid && entry.noStore,
      ),
    ).toBe(true);
    expect(report.expected.statuses).toEqual(statuses);
    expect(serialized).not.toContain('private_database_failure');
    expect(serialized).not.toContain('Idempotency-Key');
    await expect(access(join(dirname(result.resultPath), 'state'))).rejects.toThrow();
    await expect(access(join(dirname(result.resultPath), 'artifacts'))).rejects.toThrow();
  }
}, 180_000);
