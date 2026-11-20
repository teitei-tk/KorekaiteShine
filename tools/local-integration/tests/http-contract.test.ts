import { parseObject, objectAt, objectArray } from './helpers/config-json.ts';
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
  const installed = parseObject(
    await readFile(new URL('../node_modules/void/package.json', import.meta.url), 'utf8'),
  );
  expect(results.map((result) => result.mode)).toEqual(['dev', 'preview']);
  for (const result of results) {
    const report = parseObject(await readFile(result.resultPath, 'utf8'));
    expect(report).toMatchObject({
      environment: 'test',
      mode: result.mode,
      clock: 'real',
      exitCode: 0,
      case: 'interviews-http-contract',
      versions: { void: installed.version },
    });
    expect(objectAt(report.actual).cases).toEqual(
      interviewCases.map((example, index) => ({
        index,
        status: example.status,
        itemCount: example.count ?? null,
        contractValid: true,
      })),
    );
    expect(objectAt(report.expected).cases).toHaveLength(interviewCases.length);
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
    const report = parseObject(serialized);
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
    expect(objectArray(objectAt(report.actual).cases).map((entry) => entry.status)).toEqual(
      statuses,
    );
    expect(
      objectArray(objectAt(report.actual).cases).every(
        (entry) => entry.contractValid === true && entry.noStore === true,
      ),
    ).toBe(true);
    expect(objectAt(report.expected).statuses).toEqual(statuses);
    expect(serialized).not.toContain('private_database_failure');
    expect(serialized).not.toContain('Idempotency-Key');
    await expect(access(join(dirname(result.resultPath), 'state'))).rejects.toThrow();
    await expect(access(join(dirname(result.resultPath), 'artifacts'))).rejects.toThrow();
  }
}, 180_000);
