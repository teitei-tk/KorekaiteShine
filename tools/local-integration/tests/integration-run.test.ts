import { expect, test } from 'vitest';
import { runDiagnosticIntegration } from '../src/integration-run.ts';

test('一つのケースが失敗しても残りを独立した番号で実行し、全体を失敗終了にする', async () => {
  const calls: { runId: string; parallelIndex: number; scenario: string }[] = [];
  const result = await runDiagnosticIntegration(async (input) => {
    calls.push(input);
    if (input.scenario === 'retry_then_success') throw new Error('秘密値を含み得る内部例外');
  });
  expect(result.exitCode).toBe(1);
  expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls.map((input) => input.scenario)).toEqual([
    'success',
    'retry_then_success',
    'exhaust_retries',
  ]);
  expect(new Set(calls.map((input) => input.runId))).toEqual(new Set([result.runId]));
  expect(new Set(calls.map((input) => input.parallelIndex)).size).toBe(3);
  expect(result.cases.map((entry) => entry.exitCode)).toEqual([0, 1, 0]);
  expect(JSON.stringify(result)).not.toContain('秘密値');
});
