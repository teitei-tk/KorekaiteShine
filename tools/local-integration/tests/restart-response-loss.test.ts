import { parseJson } from '@korekaite/api-contracts/json';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { runDiagnosticScenario } from './helpers/restart-scenario.ts';

test('受付応答の本文を失った後も同じキーで再送し、ジョブと受付を一件のまま完了する', async () => {
  const { report, resultPath } = await runDiagnosticScenario({
    runId: randomUUID(),
    parallelIndex: 0,
    scenario: 'success',
    fault: 'response_loss',
  });
  expect(report).toMatchObject({
    environment: 'test',
    case: 'response_loss',
    clock: 'real',
    exitCode: 0,
    expected: { acceptanceCounts: { jobs: 1, requests: 1 } },
    actual: {
      responseDiscarded: true,
      startHttpStatus: 202,
      retryHttpStatus: 202,
      acceptanceBeforeRetry: { jobs: 1, requests: 1 },
      acceptanceAfterRetry: { jobs: 1, requests: 1 },
      status: 'completed',
      attemptCount: 1,
      queueObserved: true,
      checks: { doPersistence: 'passed', consumerCompletion: 'passed', dlqReceipt: 'not_expected' },
    },
  });
  expect(parseJson(await readFile(resultPath, 'utf8'))).toEqual(report);
}, 120_000);
