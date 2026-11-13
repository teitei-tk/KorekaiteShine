import { localProcessEnvironment } from './local-environment.ts';
import { confirmHttpReady } from './readiness.ts';
import { stopProcessGroup, runNodeCommand } from './process.ts';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from '@korekaite/runtime-config';
import type { BuildAudit } from './build-audit.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const production = resolveRuntime({ repositoryRoot, appEnv: 'production' });

/** 本番用入口をビルドするだけで、配置・リソース作成・DB操作は行わない。 */
export async function buildProductionArtifacts(directory: string): Promise<string> {
  const project = join(directory, 'web');
  await mkdir(project, { recursive: true });
  await cp(join(repositoryRoot, 'apps/web/src'), join(project, 'src'), {
    recursive: true,
    filter: (source) => !source.endsWith('routeTree.gen.ts'),
  });
  for (const name of ['package.json', 'tsconfig.json']) {
    await cp(join(repositoryRoot, 'apps/web', name), join(project, name));
  }
  await symlink(
    join(repositoryRoot, 'apps/web/node_modules'),
    join(project, 'node_modules'),
    'dir',
  );
  const common = {
    compatibility_date: '2026-10-19',
    compatibility_flags: ['nodejs_compat'],
    vars: { APP_ENV: 'production' },
    workers_dev: false,
    preview_urls: false,
    d1_databases: [
      { binding: 'DB', database_name: production.d1.name, database_id: production.d1.id },
    ],
  };
  const workers = ['interview', 'evaluation'] as const;
  for (const worker of workers) {
    await writeFile(
      join(project, `${worker}.production.ts`),
      `export { default${worker === 'interview' ? ', InterviewObject' : ''} } from ${JSON.stringify(join(repositoryRoot, `apps/${worker}/src/worker.ts`))};\n`,
    );
  }
  const interview = {
    ...common,
    name: production.workers.interview,
    main: join(project, 'interview.production.ts'),
    durable_objects: { bindings: [{ name: 'INTERVIEW_SESSION', class_name: 'InterviewObject' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['InterviewObject'] }],
    queues: {
      producers: [{ binding: 'EVALUATION_QUEUE', queue: production.queues.evaluation.queue }],
    },
  };
  const evaluation = {
    ...common,
    name: production.workers.evaluation,
    vars: {
      ...common.vars,
      EVALUATION_QUEUE_NAME: production.queues.evaluation.queue,
      EVALUATION_DLQ_NAME: production.queues.evaluation.dlq,
    },
    main: join(project, 'evaluation.production.ts'),
    queues: {
      producers: [
        { binding: 'EVALUATION_QUEUE', queue: production.queues.evaluation.queue },
        { binding: 'EVALUATION_DLQ', queue: production.queues.evaluation.dlq },
      ],
      consumers: [
        {
          queue: production.queues.evaluation.queue,
          max_retries: 3,
          retry_delay: 30,
          dead_letter_queue: production.queues.evaluation.dlq,
        },
        { queue: production.queues.evaluation.dlq },
      ],
    },
  };
  await writeFile(
    join(project, 'void.config.ts'),
    `export default ${JSON.stringify({ worker: { compatibility_date: common.compatibility_date }, cloudflare: { ...common, name: production.workers.web } })};\n`,
  );
  await writeFile(
    join(project, 'vite.config.ts'),
    `
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { buildAudit } from ${JSON.stringify(join(repositoryRoot, 'tools/local-integration/src/build-audit.ts'))};
export default defineConfig({ cacheDir: ${JSON.stringify(join(directory, 'vite-cache'))}, plugins: [
  voidPlugin({ persistTo: ${JSON.stringify(join(directory, 'preview-state'))}, auxiliaryWorkers: [
    { config: ${JSON.stringify(interview)}, viteEnvironment: { name: 'interview' } },
    { config: ${JSON.stringify(evaluation)}, viteEnvironment: { name: 'evaluation' } },
  ] }), tanstackStart(), react(), buildAudit(${JSON.stringify(join(project, 'build-audit'))}),
] });\n`,
  );
  await runProductionBuild(project);
  return project;
}

export async function runProductionBuild(project: string): Promise<void> {
  // 前回の監査情報や出力を今回のビルドの証拠として再利用させない。
  await rm(join(project, 'build-audit'), { recursive: true, force: true });
  await rm(join(project, 'dist'), { recursive: true, force: true });
  await rm(join(project, '.cloudflare/output'), { recursive: true, force: true });
  await runNodeCommand({
    args: [join(repositoryRoot, 'apps/web/node_modules/vite/bin/vite.js'), 'build'],
    cwd: project,
    env: {
      ...localProcessEnvironment(),
      APP_ENV: 'production',
      NO_COLOR: '1',
      VOID_INSPECTOR_PORT: 'false',
      WRANGLER_LOG_PATH: join(project, 'wrangler.log'),
    },
    logPath: join(project, 'build.log'),
    label: '本番モードのローカルビルド',
    timeoutMs: 120_000,
  });
}

export async function startProductionPreview(
  project: string,
): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  await verifyProductionArtifacts(project);
  const child = spawn(
    process.execPath,
    [
      join(repositoryRoot, 'apps/web/node_modules/vite/bin/vite.js'),
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    {
      cwd: project,
      env: {
        ...localProcessEnvironment(),
        APP_ENV: 'production',
        NO_COLOR: '1',
        VOID_INSPECTOR_PORT: 'false',
        WRANGLER_LOG_PATH: join(project, 'preview-wrangler.log'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  const outputState = { output: '' };
  async function stop() {
    await stopProcessGroup(child);
    await writeFile(join(project, 'preview.log'), outputState.output);
  }
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('本番プレビューが45秒以内に起動しませんでした。')),
        45_000,
      );
      const collect = (chunk: Buffer) => {
        outputState.output += chunk.toString();
        const match = outputState.output.match(/http:\/\/127\.0\.0\.1:\d+/u);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
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
        reject(new Error(`本番プレビュー起動失敗（${code}）: ${join(project, 'preview.log')}`));
      });
    });
    await confirmHttpReady(baseUrl);
    return { baseUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

interface WorkerConfig {
  name: string;
  workersDev: boolean;
  previewUrls: boolean;
  env: Record<
    string,
    {
      type: string;
      name?: string;
      id?: string;
      value?: string;
      worker?: string;
      exportName?: string;
    }
  >;
  triggers?: { type: string; name: string; deadLetterQueue?: string }[];
}

function workerOutputDirectory(
  project: string,
  environment: 'client' | 'ssr' | 'interview' | 'evaluation',
): string {
  return join(
    project,
    '.cloudflare/output/v0/workers',
    environment === 'client' || environment === 'ssr' ? 'default' : production.workers[environment],
  );
}

const forbiddenModule =
  /\/diagnostics\/|\/worker\.local\.ts|\/fixtures\/|\/diagnostics-validators\.mjs|\/tools\/coverage\//u;
const forbiddenContent =
  /\/api\/diagnostics|exhaust_retries|SIMULATED_AI_FAILURE|DIAGNOSTIC_(?:QUEUE|DLQ)|CHECK_OBJECT|__coverage__/u;

export async function verifyProductionArtifacts(
  directory: string,
): Promise<{ environments: string[]; routes: string[] }> {
  const project = await realpath(directory);
  const environments = ['client', 'ssr', 'interview', 'evaluation'] as const;
  for (const environment of environments) {
    const audit: BuildAudit = JSON.parse(
      await readFile(join(project, 'build-audit', `${environment}.json`), 'utf8'),
    );
    const workerDirectory = workerOutputDirectory(project, environment);
    const outputDirectory = join(workerDirectory, environment === 'client' ? 'assets' : 'bundle');
    if (
      audit.environment !== environment ||
      audit.outputDirectory !== outputDirectory ||
      !audit.modules.length ||
      !audit.outputs.length
    ) {
      throw new Error(`ビルド監査情報が不足しています: ${environment}`);
    }
    for (const module of audit.modules) {
      for (const id of [module.id, ...module.imports, ...module.dynamicImports]) {
        if (forbiddenModule.test(id)) {
          throw new Error(`本番モジュールへ診断・検証コードが混入: ${id}`);
        }
      }
    }
    if (environment === 'interview' || environment === 'evaluation') {
      const entry = join(repositoryRoot, `apps/${environment}/src/worker.ts`);
      if (!audit.modules.some((module) => module.id === entry)) {
        throw new Error(`本番入口を確認できません: ${environment}`);
      }
    }
    const recorded = new Set(audit.outputs.map((output) => output.fileName));
    for (const entry of await readdir(outputDirectory, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) {
        continue;
      }
      const fileName = relative(outputDirectory, join(entry.parentPath, entry.name));
      if (!entry.isFile() || !recorded.has(fileName)) {
        throw new Error(`未記録の本番配信物: ${fileName}`);
      }
    }
    for (const output of audit.outputs) {
      const path = resolve(outputDirectory, output.fileName);
      if (!path.startsWith(`${outputDirectory}/`)) {
        throw new Error('出力先がビルドディレクトリ外です。');
      }
      const content = await readFile(path);
      if (createHash('sha256').update(content).digest('hex') !== output.sha256) {
        throw new Error(`モジュール監査後に配信物が変更されています: ${path}`);
      }
      if (
        output.modules.some((id) => forbiddenModule.test(id)) ||
        forbiddenContent.test(content.toString())
      ) {
        throw new Error(`本番配信物へ診断コードが混入: ${path}`);
      }
    }
    if (environment !== 'client') {
      const worker = environment === 'ssr' ? 'web' : environment;
      const config: WorkerConfig = JSON.parse(
        await readFile(join(workerDirectory, 'worker.config.json'), 'utf8'),
      );
      if (
        config.name !== production.workers[worker] ||
        config.env.APP_ENV?.type !== 'text' ||
        config.env.APP_ENV.value !== 'production' ||
        config.workersDev !== false ||
        config.previewUrls !== false ||
        forbiddenContent.test(JSON.stringify(config))
      ) {
        throw new Error(`本番Worker設定に不整合があります: ${environment}`);
      }
      const bindings = Object.entries(config.env);
      const databases = bindings.filter(([, binding]) => binding.type === 'd1');
      if (
        databases.length !== 1 ||
        config.env.DB?.type !== 'd1' ||
        config.env.DB.id !== production.d1.id
      ) {
        throw new Error(`本番共有D1設定に不整合があります: ${environment}`);
      }
      const queueNames = new Set(Object.values(production.queues.evaluation));
      for (const [bindingName, binding] of bindings) {
        if (
          binding.type === 'queue' &&
          (binding.name === undefined || !queueNames.has(binding.name))
        ) {
          throw new Error(`本番以外のQueueが設定されています: ${environment}`);
        }
        if (binding.type === 'durable-object') {
          if (
            environment !== 'interview' ||
            bindingName !== 'INTERVIEW_SESSION' ||
            binding.worker !== production.workers.interview ||
            binding.exportName !== 'InterviewObject'
          ) {
            throw new Error(`本番の面接DO設定に不整合があります: ${environment}`);
          }
          continue;
        }
        if (!['d1', 'text', 'queue', 'assets'].includes(binding.type)) {
          throw new Error(`未実装の本番入口に検証用bindingがあります: ${environment}`);
        }
      }
      if (environment === 'interview' && config.env.INTERVIEW_SESSION?.type !== 'durable-object') {
        throw new Error('本番の面接DO設定がありません。');
      }
      for (const trigger of config.triggers ?? []) {
        if (
          trigger.type !== 'queue' ||
          !queueNames.has(trigger.name) ||
          (trigger.deadLetterQueue !== undefined && !queueNames.has(trigger.deadLetterQueue))
        ) {
          throw new Error(`本番以外のQueueが設定されています: ${environment}`);
        }
      }
    }
  }
  const routes = (await readdir(join(project, 'src/routes'))).sort();
  if (
    JSON.stringify(routes) !==
    JSON.stringify([
      '__root.tsx',
      'api.interview-history.ts',
      'api.interviews.$interviewId.live.ts',
      'api.interviews.$interviewId.retry.ts',
      'api.interviews.$interviewId.ts',
      'api.interviews.ts',
      'api.local-session.ts',
      'api.materials.analyze.ts',
      'index.tsx',
      'practice.tsx',
    ])
  ) {
    throw new Error('本番ルート走査対象に未確認のルートがあります。');
  }
  const tree = await readFile(join(project, 'src/routeTree.gen.ts'), 'utf8');
  if (forbiddenContent.test(tree) || tree.includes('diagnostics')) {
    throw new Error('本番ルートツリーに診断が混入しています。');
  }
  for (const route of routes) {
    if (!tree.includes(`'./routes/${route.replace(/\.tsx?$/u, '')}'`)) {
      throw new Error(`生成ルートに不足があります: ${route}`);
    }
  }
  return { environments: [...environments], routes };
}
