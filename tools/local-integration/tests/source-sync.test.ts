import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { buildRuntime, runDatabaseCommand, startRuntime } from '../src/runtime.ts';
import type { LocalRuntime } from '../src/runtime.ts';

test('元ソースに存在しないAPIは再起動・再ビルドで消え、保存済みD1は保持する', async () => {
  const config = resolveRuntime({
    repositoryRoot: fileURLToPath(new URL('../../../', import.meta.url)),
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtimeContext = { runtime: undefined as LocalRuntime | undefined };
  try {
    runtimeContext.runtime = await startRuntime(config, 'dev');
    await runDatabaseCommand(config, [
      'execute',
      "INSERT INTO connection_checks (writer, value) VALUES ('source-sync-sentinel', 'retained');",
    ]);
    await runtimeContext.runtime.stop();
    runtimeContext.runtime = undefined;
    for (const mode of ['dev', 'preview'] as const) {
      // 元ソースから削除されたAPIが、以前の生成用コピーに残った状態を再現する。
      await writeFile(
        join(config.artifactDirectory, 'web/src/routes/api.obsolete-test.ts'),
        `import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/api/obsolete-test')({
  server: { handlers: { GET: () => new Response('obsolete-route') } },
});\n`,
      );
      if (mode === 'preview') {
        await buildRuntime(config);
      }
      runtimeContext.runtime = await startRuntime(config, mode);
      const response = await fetch(`${runtimeContext.runtime.baseUrl}/api/obsolete-test`);
      expect(response.status, mode).toBe(404);
      await runDatabaseCommand(config, [
        'execute',
        "CREATE TEMP TABLE one (count INTEGER CHECK (count = 1)); INSERT INTO one SELECT COUNT(*) FROM connection_checks WHERE writer = 'source-sync-sentinel' AND value = 'retained';",
      ]);
      await runtimeContext.runtime.stop();
      runtimeContext.runtime = undefined;
    }
  } finally {
    await runtimeContext.runtime?.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 120_000);
