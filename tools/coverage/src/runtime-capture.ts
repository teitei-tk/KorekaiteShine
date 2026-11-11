import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startCapture } from './capture.ts';
import type { CoverageRun } from './merge.ts';
import { readWorkerCoverage } from './worker.ts';
import { findWorkerdInspector } from './workerd-inspector.ts';

/** Viteが先に失われても、残ったworkerdから停止前に回収する。 */
export async function startRuntimeCapture(
  parentPid: number,
  baseUrl: string,
  names: readonly string[],
) {
  const { run, directory }: { run: CoverageRun; directory: string } = JSON.parse(
    readFileSync(process.env.KOREKAITE_COVERAGE_RUN!, 'utf8'),
  );
  const endpoints = await findWorkerdInspector(parentPid, names);
  const debug = await (await fetch(new URL('/__debug', baseUrl))).text();
  const address = debug.match(/ws=localhost%3A(\d+)%2F/u);
  if (!address) {
    throw new Error('Worker計測のInspectorプロキシが見つかりません');
  }
  const proxyEndpoints = (await (
    await fetch(`http://127.0.0.1:${address[1]}/json/list`)
  ).json()) as { id: string; webSocketDebuggerUrl: string }[];
  const workers = names.map((name) => ({
    name,
    epoch: randomUUID(),
    proxy: proxyEndpoints.find(
      (endpoint) => new URL(endpoint.webSocketDebuggerUrl).pathname === `/${name}`,
    )!.webSocketDebuggerUrl,
    socket: endpoints.find((endpoint) => endpoint.id === `core:user:${name}`)!.webSocketDebuggerUrl,
    capture: startCapture(run, process.env.KOREKAITE_COVERAGE_SUITE!, directory),
  }));
  await Promise.all(
    workers.map(async ({ proxy, epoch }) => {
      await readWorkerCoverage(proxy, { value: epoch, start: true });
    }),
  );
  return async () => {
    await Promise.all(
      workers.map(async ({ name, proxy, socket, capture, epoch }) => {
        try {
          const parentAliveState = { parentAlive: true };
          try {
            process.kill(parentPid, 0);
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
              parentAliveState.parentAlive = false;
            } else {
              throw error;
            }
          }
          capture.finish(
            await readWorkerCoverage(parentAliveState.parentAlive ? proxy : socket, {
              value: epoch,
            }),
            'complete',
          );
        } catch (error) {
          capture.finish(
            {},
            'failed',
            `${name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  };
}
