import { runDatabaseCommand } from './database.ts';
export { runDatabaseCommand } from './database.ts';
import { spawn } from 'node:child_process';
import { cp, mkdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from '@korekaite/runtime-config';
import { claimArtifactDirectory } from '@korekaite/runtime-config/artifacts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

export interface LocalRuntime {
  baseUrl: string;
  stop(): Promise<void>;
  runScheduled(): Promise<void>;
}

async function prepareRuntime(config: RuntimeConfig): Promise<string> {
  if (config.environment === 'production' || !config.stateDirectory) {
    throw new Error('ローカル環境だけを起動できます。');
  }
  await claimArtifactDirectory(config);
  await runDatabaseCommand(config, ['migrate']);
  const project = join(config.artifactDirectory, 'web');
  await mkdir(project, { recursive: true });
  await cp(join(repositoryRoot, 'apps/web/src'), join(project, 'src'), {
    recursive: true,
    filter: (source) => !source.endsWith('routeTree.gen.ts'),
  });
  await cp(join(repositoryRoot, 'apps/web/package.json'), join(project, 'package.json'));
  await cp(join(repositoryRoot, 'apps/web/tsconfig.json'), join(project, 'tsconfig.json'));
  const modulesSource = join(repositoryRoot, 'apps/web/node_modules');
  const modulesTarget = join(project, 'node_modules');
  try {
    await symlink(modulesSource, modulesTarget, 'dir');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    if ((await readlink(modulesTarget)) !== modulesSource)
      throw new Error('Web依存の参照先が一致しません。');
  }
  const fixtures = join(repositoryRoot, 'tools/local-integration/fixtures');
  await cp(join(fixtures, 'api.topology.ts'), join(project, 'src/routes/api.topology.ts'));
  await cp(
    join(fixtures, 'api.database-topology.ts'),
    join(project, 'src/routes/api.database-topology.ts'),
  );
  await cp(
    join(fixtures, 'api.batch-topology.ts'),
    join(project, 'src/routes/api.batch-topology.ts'),
  );
  await cp(
    join(fixtures, 'api.primary-topology.ts'),
    join(project, 'src/routes/api.primary-topology.ts'),
  );
  const common = {
    d1_databases: [{ binding: 'DB', database_name: config.d1.name, database_id: config.d1.id }],
    compatibility_date: '2026-10-19',
    compatibility_flags: ['nodejs_compat'],
    vars: { APP_ENV: config.environment },
  };
  const interview = {
    ...common,
    name: config.workers.interview,
    main: join(fixtures, 'interview.ts'),
    durable_objects: { bindings: [{ name: 'INTERVIEW', class_name: 'TopologyObject' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['TopologyObject'] }],
  };
  const evaluation = {
    ...common,
    name: config.workers.evaluation,
    main: join(fixtures, 'evaluation.ts'),
    triggers: { crons: ['* * * * *'] },
  };
  const web = {
    ...common,
    name: config.workers.web,
    services: [
      {
        binding: 'EVALUATION_PROBE',
        service: config.workers.evaluation,
        entrypoint: 'TopologyEvaluation',
      },
    ],
    durable_objects: {
      bindings: [{ name: 'INTERVIEW', class_name: 'TopologyObject', script_name: config.doOwner }],
    },
  };
  await writeFile(
    join(project, 'void.config.ts'),
    `export default ${JSON.stringify({ worker: { compatibility_date: common.compatibility_date }, cloudflare: web })};\n`,
  );
  await writeFile(
    join(project, 'vite.config.ts'),
    `
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ cacheDir: ${JSON.stringify(join(config.artifactDirectory, 'vite-cache'))}, plugins: [
  voidPlugin({ persistTo: ${JSON.stringify(config.stateDirectory)}, auxiliaryWorkers: [
    { config: ${JSON.stringify(interview)}, viteEnvironment: { name: 'interview' } },
    { config: ${JSON.stringify(evaluation)}, viteEnvironment: { name: 'evaluation' } },
  ] }), tanstackStart(), react(),
] });
`,
  );
  return project;
}

function runtimeEnvironment(config: RuntimeConfig) {
  return {
    ...process.env,
    APP_ENV: config.environment,
    NO_COLOR: '1',
    VOID_INSPECTOR_PORT: 'false',
    WRANGLER_LOG_PATH: join(config.artifactDirectory, 'wrangler.log'),
  };
}

export async function buildRuntime(config: RuntimeConfig): Promise<void> {
  const project = await prepareRuntime(config);
  const child = spawn(
    process.execPath,
    [join(repositoryRoot, 'apps/web/node_modules/vite/bin/vite.js'), 'build'],
    {
      cwd: project,
      env: runtimeEnvironment(config),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const logPath = join(config.artifactDirectory, 'build.log');
  await writeFile(logPath, output);
  if (code !== 0) throw new Error(`ローカルビルド失敗（${code}）。${logPath}を確認してください。`);
}

export async function startRuntime(
  config: RuntimeConfig,
  mode: 'dev' | 'preview' = 'dev',
): Promise<LocalRuntime> {
  const project = await prepareRuntime(config);
  const child = spawn(
    process.execPath,
    [
      join(repositoryRoot, 'apps/web/node_modules/vite/bin/vite.js'),
      ...(mode === 'preview' ? ['preview'] : []),
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    {
      cwd: project,
      env: runtimeEnvironment(config),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let output = '';
  const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  async function stop(): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
    await stopped;
    await writeFile(join(config.artifactDirectory, 'runtime.log'), output);
  }
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('ローカル起動が45秒以内に完了しませんでした。')),
        45_000,
      );
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        const found = output.match(/http:\/\/127\.0\.0\.1:\d+/u);
        if (found) {
          clearTimeout(timeout);
          resolve(found[0]);
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `ローカル起動失敗（${code}）。${join(config.artifactDirectory, 'runtime.log')}を確認してください。`,
          ),
        );
      });
    });
    // HTTPが利用可能になるまで待ち、起動ログだけで成功にしない。
    const response = await fetch(baseUrl);
    if (!response.ok) throw new Error(`Web起動確認が${response.status}で失敗しました。`);
    return {
      baseUrl,
      stop,
      async runScheduled() {
        const url = new URL('/cdn-cgi/local/explorer/api/local/scheduled', baseUrl);
        url.searchParams.set('worker', config.workers.evaluation);
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cron: '* * * * *' }),
        });
        const body = await response.json();
        if (!response.ok || body.result?.outcome !== 'ok') {
          throw new Error(`scheduledイベント失敗: ${JSON.stringify(body)}`);
        }
      },
    };
  } catch (error) {
    await stop();
    await writeFile(join(config.artifactDirectory, 'runtime.log'), output);
    throw error;
  }
}
