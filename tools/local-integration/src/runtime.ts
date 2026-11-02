import { lockEnvironment } from './lock.ts';
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

export interface LocalRuntimeOptions {
  /** 受付・障害境界テストでだけ使用し、通常起動では自動初期化する。 */
  manualDiagnostics?: boolean;
  /** DO・送信境界のテストだけで評価の業務処理を保留する。 */
  probeOnlyEvaluation?: boolean;
}

async function prepareRuntime(
  config: RuntimeConfig,
  options: LocalRuntimeOptions = {},
): Promise<string> {
  if ((options.manualDiagnostics || options.probeOnlyEvaluation) && config.environment !== 'test')
    throw new Error('初期化の保留は独立test環境だけで利用できます。');
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
  await writeFile(
    join(project, 'src/routes/api.diagnostics.check-jobs.ts'),
    `import { createFileRoute } from '@tanstack/react-router';
import { env, waitUntil } from 'cloudflare:workers';
import { createPrimaryDb } from '@korekaite/database/connection';
import { acceptCheck } from '../diagnostics/accept';
export const Route = createFileRoute('/api/diagnostics/check-jobs')({
  server: { handlers: { POST: ({ request }) => acceptCheck(request, {
    db: createPrimaryDb(env.DB), environment: ${JSON.stringify(config.environment)},
    actorId: 'local-developer', now: () => Date.now(), newId: () => crypto.randomUUID(),
    scheduleInitialization: ${options.manualDiagnostics ? 'undefined' : `jobId => waitUntil(env.CHECK_OBJECT.getByName(env.APP_ENV + ':diagnostics:' + jobId).initializeCheck(jobId).catch(() => console.info(JSON.stringify({ event: 'diagnostic_initialization_deferred', jobId }))))`},
  }) } },
});\n`,
  );
  await writeFile(
    join(project, 'src/routes/api.diagnostics.check-jobs.$jobId.ts'),
    `import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { createPrimaryDb } from '@korekaite/database/connection';
import { getCheck } from '../diagnostics/get';
export const Route = createFileRoute('/api/diagnostics/check-jobs/$jobId')({
  server: { handlers: { GET: ({ request, params }) => getCheck(request, params.jobId, {
    db: createPrimaryDb(env.DB), environment: ${JSON.stringify(config.environment)},
    actorId: 'local-developer', now: () => Date.now(), newId: () => crypto.randomUUID(),
  }) } },
});\n`,
  );
  if (config.environment === 'test') {
    await cp(join(fixtures, 'api.lease-test.ts'), join(project, 'src/routes/api.lease-test.ts'));
    await cp(
      join(fixtures, 'api.evaluation-test.ts'),
      join(project, 'src/routes/api.evaluation-test.ts'),
    );
    await cp(
      join(fixtures, 'api.check-object-test.ts'),
      join(project, 'src/routes/api.check-object-test.ts'),
    );
  }
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
  await cp(
    join(fixtures, 'api.queue-contract-topology.ts'),
    join(project, 'src/routes/api.queue-contract-topology.ts'),
  );
  const common = {
    d1_databases: [{ binding: 'DB', database_name: config.d1.name, database_id: config.d1.id }],
    compatibility_date: '2026-10-19',
    compatibility_flags: ['nodejs_compat'],
    vars: { APP_ENV: config.environment },
  };
  const interviewEntry = join(project, 'interview.local.ts');
  await writeFile(
    interviewEntry,
    `export { default, CheckObject } from ${JSON.stringify(join(repositoryRoot, 'apps/interview/src/worker.local.ts'))};\nexport { TopologyObject } from ${JSON.stringify(join(fixtures, 'interview.ts'))};\n`,
  );
  const diagnostics = config.queues.diagnostics;
  if (!diagnostics) throw new Error('ローカル診断Queueが未設定です。');
  const interview = {
    ...common,
    name: config.workers.interview,
    main: interviewEntry,
    queues: { producers: [{ binding: 'DIAGNOSTIC_QUEUE', queue: diagnostics.queue }] },
    durable_objects: {
      bindings: [
        { name: 'INTERVIEW', class_name: 'TopologyObject' },
        { name: 'CHECK_OBJECT', class_name: 'CheckObject' },
      ],
    },
    migrations: [
      { tag: 'v1', new_sqlite_classes: ['TopologyObject'] },
      { tag: 'v2', new_sqlite_classes: ['CheckObject'] },
    ],
  };
  const evaluationEntry = join(project, 'evaluation.local.ts');
  await writeFile(
    evaluationEntry,
    `import application from ${JSON.stringify(join(repositoryRoot, 'apps/evaluation/src/worker.local.ts'))};
import probe, { recordQueueDelivery } from ${JSON.stringify(join(fixtures, 'evaluation.ts'))};
export { TopologyEvaluation } from ${JSON.stringify(join(fixtures, 'evaluation.ts'))};
export default {
  queue: ${options.probeOnlyEvaluation ? 'probe.queue' : 'async (batch, env) => { await recordQueueDelivery(batch); await application.queue(batch, env); }'},
  async scheduled(controller, env) { await application.scheduled(controller, env); await probe.scheduled(controller); },
};\n`,
  );
  const evaluation = {
    ...common,
    name: config.workers.evaluation,
    vars: {
      ...common.vars,
      DIAGNOSTIC_QUEUE_NAME: diagnostics.queue,
      DIAGNOSTIC_DLQ_NAME: diagnostics.dlq,
    },
    main: evaluationEntry,
    durable_objects: {
      bindings: [{ name: 'CHECK_OBJECT', class_name: 'CheckObject', script_name: config.doOwner }],
    },
    queues: {
      producers: [
        { binding: 'DIAGNOSTIC_QUEUE', queue: diagnostics.queue },
        { binding: 'DIAGNOSTIC_DLQ', queue: diagnostics.dlq },
        { binding: 'EVALUATION_QUEUE', queue: config.queues.evaluation.queue },
        { binding: 'EVALUATION_DLQ', queue: config.queues.evaluation.dlq },
      ],
      consumers: [
        {
          queue: diagnostics.queue,
          max_batch_size: 1,
          max_batch_timeout: 1,
          max_retries: 3,
          retry_delay: 30,
          dead_letter_queue: diagnostics.dlq,
        },
        {
          queue: diagnostics.dlq,
          max_batch_size: 1,
          max_batch_timeout: 1,
          max_retries: 3,
          retry_delay: 30,
        },
      ],
    },
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
      bindings: [
        { name: 'INTERVIEW', class_name: 'TopologyObject', script_name: config.doOwner },
        { name: 'CHECK_OBJECT', class_name: 'CheckObject', script_name: config.doOwner },
      ],
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

async function buildUnlockedRuntime(config: RuntimeConfig): Promise<void> {
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

async function startUnlockedRuntime(
  config: RuntimeConfig,
  mode: 'dev' | 'preview' = 'dev',
  options: LocalRuntimeOptions = {},
): Promise<LocalRuntime> {
  const project = await prepareRuntime(config, options);
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

export async function buildRuntime(config: RuntimeConfig): Promise<void> {
  const release = await lockEnvironment(config);
  try {
    await buildUnlockedRuntime(config);
  } finally {
    release();
  }
}

export async function startRuntime(
  config: RuntimeConfig,
  mode: 'dev' | 'preview' = 'dev',
  options: LocalRuntimeOptions = {},
): Promise<LocalRuntime> {
  if (mode === 'preview' && (options.manualDiagnostics || options.probeOnlyEvaluation))
    throw new Error('ビルド済みWorkerは自動初期化で検証してください。');
  const release = await lockEnvironment(config);
  try {
    const runtime = await startUnlockedRuntime(config, mode, options);
    return {
      ...runtime,
      async stop() {
        try {
          await runtime.stop();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
