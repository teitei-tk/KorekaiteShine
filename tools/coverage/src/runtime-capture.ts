import { readCoverageConfig, required, readEndpoints } from './schema.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startCapture } from './capture.ts';
import { readWorkerCoverage } from './worker.ts';
import { findWorkerdInspector } from './workerd-inspector.ts';

/** Viteが先に失われても、残ったworkerdから停止前に回収する。 */
export async function startRuntimeCapture(
  parentPid: number,
  baseUrl: string,
  names: readonly string[],
) {
  const settings = readCoverageConfig(
    readFileSync(required(process.env.KOREKAITE_COVERAGE_RUN, 'KOREKAITE_COVERAGE_RUN'), 'utf8'),
  );
  const { run } = settings;
  const directory = required(settings.directory, 'directory');
  const endpoints = await findWorkerdInspector(parentPid, names);
  const debug = await (await fetch(new URL('/__debug', baseUrl))).text();
  const address = /ws=localhost%3A(?<port>\d+)%2F/u.exec(debug);
  if (!address) {
    throw new Error('Worker計測のInspectorプロキシが見つかりません');
  }
  const proxyEndpoints = readEndpoints(
    await (await fetch(`http://127.0.0.1:${address[1]}/json/list`)).json(),
  );
  const workers = names.map((name) => {
    const proxy = proxyEndpoints.find(
      (endpoint) => new URL(endpoint.webSocketDebuggerUrl).pathname === `/${name}`,
    );
    const socket = endpoints.find((endpoint) => endpoint.id === `core:user:${name}`);
    if (proxy === undefined || socket === undefined) {
      throw new Error(`Worker計測のInspector接続先がありません: ${name}`);
    }
    return {
      name,
      epoch: randomUUID(),
      proxy: proxy.webSocketDebuggerUrl,
      socket: socket.webSocketDebuggerUrl,
      capture: startCapture(
        run,
        required(process.env.KOREKAITE_COVERAGE_SUITE, 'KOREKAITE_COVERAGE_SUITE'),
        directory,
      ),
    };
  });
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
