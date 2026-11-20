import { runDiagnosticScenario as runScenario } from '../../src/integration.ts';

export async function runDiagnosticScenario(input: Parameters<typeof runScenario>[0]) {
  const result = await runScenario(input);
  process.stdout.write(
    `restart-timing ${JSON.stringify({
      case: result.report.case,
      ...result.report.timings,
      totalMs: result.report.durationMs,
    })}\n`,
  );
  return result;
}
