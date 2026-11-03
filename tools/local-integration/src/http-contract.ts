import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from '@korekaite/runtime-config';
import {
  assertInterviewResponse,
  interviewCases,
} from '../../../apps/web/tests/contracts/interviews.ts';
import { runWithEvidence } from './evidence.ts';
import { runtimeVersions } from './versions.ts';
import { buildRuntime, startRuntime } from './runtime.ts';

export { runDiagnosticHttpContractIntegration } from './diagnostic-http-contract.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

export async function runHttpContractIntegration(): Promise<
  { mode: 'dev' | 'preview'; resultPath: string }[]
> {
  const runId = randomUUID();
  const results: { mode: 'dev' | 'preview'; resultPath: string }[] = [];
  for (const [parallelIndex, mode] of (['dev', 'preview'] as const).entries()) {
    const config = resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex });
    const resultPath = join(dirname(config.artifactDirectory), 'results.json');
    await runWithEvidence(
      {
        resultPath,
        metadata: {
          environment: 'test',
          runId,
          parallelIndex,
          mode,
          clock: 'real',
          case: 'interviews-http-contract',
          versions: await runtimeVersions(),
          expected: {
            cases: interviewCases.map((example, index) => ({
              index,
              status: example.status,
              itemCount: example.count ?? null,
            })),
          },
        },
      },
      async (evidence) => {
        evidence.cleanup(async (passed) => {
          if (!passed) return;
          await rm(config.stateDirectory!, { recursive: true, force: true });
          await rm(config.artifactDirectory, { recursive: true, force: true });
        });
        if (mode === 'preview') await buildRuntime(config);
        const runtime = await startRuntime(config, mode);
        evidence.cleanup(() => runtime.stop());
        const cases: {
          index: number;
          status: number;
          itemCount: number | null;
          contractValid: boolean;
        }[] = [];
        evidence.observe({ cases });
        for (const [index, example] of interviewCases.entries()) {
          const response = await fetch(`${runtime.baseUrl}/api/interviews?${example.query}`, {
            signal: AbortSignal.timeout(10_000),
          });
          const observation = {
            index,
            status: response.status,
            itemCount: null as number | null,
            contractValid: false,
          };
          cases.push(observation);
          const body = await response.clone().json();
          if (Array.isArray(body.items)) observation.itemCount = body.items.length;
          await assertInterviewResponse(response, example);
          observation.contractValid = true;
        }
      },
    );
    results.push({ mode, resultPath });
  }
  return results;
}
