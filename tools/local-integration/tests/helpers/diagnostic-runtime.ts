import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime, type RuntimeConfig } from '@korekaite/runtime-config';
import { startRuntime, type LocalRuntime, type LocalRuntimeOptions } from '../../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export async function withDiagnosticRuntime(
  options: Pick<LocalRuntimeOptions, 'checkObjectProbe'>,
  run: (config: RuntimeConfig, runtime: LocalRuntime) => Promise<void>,
) {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', {
    manualDiagnostics: true,
    probeOnlyEvaluation: true,
    ...options,
  });
  let succeeded = false;
  try {
    await run(config, runtime);
    succeeded = true;
  } finally {
    await runtime.stop();
    // 失敗時は原因調査のためログと状態を残す。
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}
