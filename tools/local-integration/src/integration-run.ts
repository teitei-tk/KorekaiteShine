import { randomUUID } from 'node:crypto';
import { runDiagnosticScenario } from './integration.ts';

type ScenarioInput = Parameters<typeof runDiagnosticScenario>[0];

export async function runDiagnosticIntegration(
  runCase: (input: ScenarioInput) => Promise<void> = async (input) => {
    await runDiagnosticScenario(input);
  },
): Promise<{
  runId: string;
  exitCode: 0 | 1;
  cases: { scenario: ScenarioInput['scenario']; parallelIndex: number; exitCode: 0 | 1 }[];
}> {
  const runId = randomUUID();
  const cases: { scenario: ScenarioInput['scenario']; parallelIndex: number; exitCode: 0 | 1 }[] =
    [];
  const scenarios = ['success', 'retry_then_success', 'exhaust_retries'] as const;
  for (const [parallelIndex, scenario] of scenarios.entries()) {
    try {
      await runCase({ runId, parallelIndex, scenario });
    } catch {
      // 詳細は各ケースの安全な結果コードで追跡し、内部例外は集計へ転記しない。
      cases.push({ scenario, parallelIndex, exitCode: 1 });
      continue;
    }
    cases.push({ scenario, parallelIndex, exitCode: 0 });
  }
  return { runId, exitCode: cases.some((entry) => entry.exitCode === 1) ? 1 : 0, cases };
}
