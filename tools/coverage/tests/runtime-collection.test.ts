import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { resolveRuntime } from '../../../packages/runtime-config/src/resources.ts';
import { startRuntime } from '../../local-integration/src/runtime.ts';
import { prepareRun } from '../src/prepare.ts';
import { readCaptures } from '../src/capture.ts';

test.each(['stop', 'kill-vite'] as const)(
  '実際の3 WorkersでWeb原本を計測し%sでも回収する',
  async (mode) => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const workspace = mkdtempSync(join(tmpdir(), 'coverage-runtime-'));
    const path = 'apps/web/src/server/interviews.ts';
    const { run } = prepareRun(root, [path], 'revision', ['fixture']);
    const directory = join(workspace, 'captures');
    const configFile = join(workspace, 'run.json');
    writeFileSync(configFile, JSON.stringify({ root, directory, run }));
    vi.stubEnv('KOREKAITE_COVERAGE_RUN', configFile);
    vi.stubEnv('KOREKAITE_COVERAGE_SUITE', 'fixture');
    const runtimeState = {
      runtime: undefined as Awaited<ReturnType<typeof startRuntime>> | undefined,
    };
    try {
      const config = resolveRuntime({
        repositoryRoot: workspace,
        appEnv: 'test',
        runId: 'coverage',
        parallelIndex: 0,
      });
      runtimeState.runtime = await startRuntime(config);
      expect((await fetch(`${runtimeState.runtime.baseUrl}/api/interviews`)).status).toBe(200);
      if (mode === 'kill-vite') {
        const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
          .trim()
          .split('\n')
          .map((row) => row.trim().split(/\s+/u).map(Number));
        const tree = new Set([process.pid]);
        while (true) {
          const previous = tree.size;
          for (const [pid, parent] of rows) {
            if (tree.has(parent)) {
              tree.add(pid);
            }
          }
          if (tree.size === previous) {
            break;
          }
        }
        const vite = rows.find(
          ([pid, , group]) => pid !== process.pid && tree.has(pid) && pid === group,
        );
        expect(vite).toBeDefined();
        process.kill(vite![0], 'SIGKILL');
        expect(await runtimeState.runtime.closed).toEqual({ exitCode: 1 });
        await expect(runtimeState.runtime.stop()).rejects.toThrow('予期せず終了');
      } else {
        await runtimeState.runtime.stop();
      }
      runtimeState.runtime = undefined;
      const records = readCaptures(directory);
      const web = records.flatMap((record) => record.files).find((file) => file.path === path);
      expect(
        web,
        JSON.stringify(
          records.map((record) => ({
            status: record.status,
            failure: record.failure,
            files: record.files.map((file) => file.path),
          })),
        ),
      ).toBeDefined();
      expect(Object.values(web!.coverage.f).some((count) => count > 0)).toBe(true);
      expect(records.every((record) => record.status === 'complete')).toBe(true);
    } finally {
      await runtimeState.runtime?.stop();
      vi.unstubAllEnvs();
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  60000,
);
