import type { JsonValue } from '@korekaite/api-contracts/json';
import { parseJson } from '@korekaite/api-contracts/json';
import { resolveRuntime } from '@korekaite/runtime-config';
import type { RuntimeConfig } from '@korekaite/runtime-config';
import { createHash, randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  readlink,
  symlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
export type BoundaryFlags = { manualDiagnostics?: boolean; probeOnlyEvaluation?: boolean };
export function boundaryTestFile(file: string): boolean {
  return /(?:^|\/)(?:check-object|dlq|diagnostics|delivery-anomalies|built-boundary-runtime)\.test\.ts$/u.test(
    file,
  );
}
function object(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('境界ビルドの設定が不正です。');
  }
  return value;
}
function identities(config: RuntimeConfig): string[] {
  if (config.environment !== 'test' || !config.stateDirectory || !config.queues.diagnostics) {
    throw new Error('境界ビルドは独立test環境専用です。');
  }
  return [
    config.workers.web,
    config.workers.interview,
    config.workers.evaluation,
    config.d1.id,
    config.d1.name,
    config.queues.evaluation.queue,
    config.queues.evaluation.dlq,
    config.queues.diagnostics.queue,
    config.queues.diagnostics.dlq,
  ];
}
function substitute(value: JsonValue, replacements: Map<string, string>): JsonValue {
  if (typeof value === 'string') {
    return replacements.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitute(item, replacements));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, replacements)]),
    );
  }
  return value;
}
export function rebindBoundaryConfig(
  input: JsonValue,
  source: RuntimeConfig,
  target: RuntimeConfig,
  flags: BoundaryFlags,
): JsonValue {
  const sourceIds = identities(source);
  const targetIds = identities(target);
  const replacements = new Map(sourceIds.map((value, index) => [value, targetIds[index]]));
  const config = object(input);
  const workers = Object.values(source.workers);
  if (typeof config.name !== 'string' || !workers.includes(config.name)) {
    throw new Error('境界ビルドのWorker名が一致しません。');
  }
  const env = object(config.env);
  if (object(env.APP_ENV).value !== 'test' || object(env.DB).id !== source.d1.id) {
    throw new Error('境界ビルドの環境またはDBが一致しません。');
  }
  for (const value of Object.values(env)) {
    const binding = object(value);
    if (binding.type === 'd1') {
      if (binding.id !== source.d1.id || binding.name !== source.d1.name) {
        throw new Error('未知のDBです。');
      }
    } else if (binding.type === 'queue') {
      if (typeof binding.name !== 'string' || !sourceIds.slice(5).includes(binding.name)) {
        throw new Error('未知のQueueです。');
      }
    } else if (binding.type === 'worker' || binding.type === 'durable-object') {
      if (typeof binding.worker !== 'string' || !workers.includes(binding.worker)) {
        throw new Error('未知のWorker参照です。');
      }
    } else if (binding.type !== 'text') {
      throw new Error('未対応のbindingです。');
    }
  }
  if (Object.hasOwn(config, 'triggers')) {
    if (!Array.isArray(config.triggers)) {
      throw new TypeError('triggerが不正です。');
    }
    for (const value of config.triggers) {
      const trigger = object(value);
      if (trigger.type === 'queue') {
        if (
          typeof trigger.name !== 'string' ||
          !sourceIds.slice(5).includes(trigger.name) ||
          (Object.hasOwn(trigger, 'deadLetterQueue') &&
            (typeof trigger.deadLetterQueue !== 'string' ||
              !sourceIds.slice(5).includes(trigger.deadLetterQueue)))
        ) {
          throw new Error('未知のQueue triggerです。');
        }
      } else if (trigger.type !== 'scheduled') {
        throw new Error('未対応のtriggerです。');
      }
    }
  }
  const result = object(substitute(input, replacements));
  return {
    ...result,
    env: {
      ...object(result.env),
      BOUNDARY_MANUAL_DIAGNOSTICS: {
        type: 'text',
        value: String(flags.manualDiagnostics ?? false),
      },
      BOUNDARY_PROBE_ONLY_EVALUATION: {
        type: 'text',
        value: String(flags.probeOnlyEvaluation ?? false),
      },
    },
  };
}

export async function boundaryCoverageIdentity(): Promise<string | null> {
  const path = process.env.KOREKAITE_COVERAGE_RUN;
  return path
    ? createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    : null;
}

export async function createBoundaryBundle(signal?: AbortSignal) {
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort(new Error('境界ビルドを中断しました。'));
  };
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const runId = randomUUID();
  const config = resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex: 0 });
  const directory = join(config.artifactDirectory, 'web');
  const dispose = () => rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  const started = performance.now();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    combined.throwIfAborted();
    const coverage = await boundaryCoverageIdentity();
    const { buildRuntime } = await import('./runtime.ts');
    await buildRuntime(config, { boundaryBuild: true }, combined);
    const output = join(directory, '.cloudflare/output/v1');
    for (const file of await readdir(output, { recursive: true })) {
      if (!file.endsWith('.js')) {
        continue;
      }
      const code = await readFile(join(output, file), 'utf8');
      if (identities(config).some((id) => code.includes(id))) {
        throw new Error('ビルド済みコードにビルド元の接続先が埋め込まれています。');
      }
    }
    if (coverage !== (await boundaryCoverageIdentity())) {
      throw new Error('ビルド中にcoverage設定が変更されました。');
    }
    await writeFile(
      join(directory, 'boundary-bundle.json'),
      JSON.stringify({ schema: 1, runId, coverage }),
    );
    process.stdout.write(
      `boundary-build-timing ${JSON.stringify({ totalMs: performance.now() - started })}\n`,
    );
    return { directory, dispose };
  } catch (error) {
    for (const name of ['build.log', 'db-migrate.log']) {
      const log = await readFile(join(config.artifactDirectory, name), 'utf8').catch(() => '');
      if (log) {
        process.stderr.write(`boundary-build-failure ${name}\n${log.slice(-8000)}\n`);
      }
    }
    throw new Error(`境界ビルドが失敗しました。ログを保持しています: ${config.artifactDirectory}`, {
      cause: error,
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

export async function stageBoundaryBundle(
  directory: string,
  config: RuntimeConfig,
  flags: BoundaryFlags,
): Promise<string> {
  identities(config);
  const manifest = object(
    parseJson(await readFile(join(directory, 'boundary-bundle.json'), 'utf8')),
  );
  if (
    manifest.schema !== 1 ||
    typeof manifest.runId !== 'string' ||
    manifest.coverage !== (await boundaryCoverageIdentity())
  ) {
    throw new Error('境界ビルドの識別情報が不正です。');
  }
  const source = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: manifest.runId,
    parallelIndex: 0,
  });
  if (
    (await realpath(directory)) !== join(source.artifactDirectory, 'web') ||
    source.d1.id === config.d1.id
  ) {
    throw new Error('ビルド元とケースの保存先を分離してください。');
  }
  for (const entry of await readdir(join(directory, '.cloudflare/output/v1'), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() && !entry.isDirectory()) {
      throw new Error('共有ビルドにリンクや特殊ファイルを含められません。');
    }
  }
  const project = join(config.artifactDirectory, 'web');
  const target = join(project, '.cloudflare/output/v1');
  await mkdir(project, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(join(directory, '.cloudflare/output/v1'), target, { recursive: true });
  const folders = await readdir(join(target, 'workers'));
  if (folders.length !== 3) {
    throw new Error('境界ビルドの3 Workerが不足しています。');
  }
  const names = new Set<string>();
  for (const folder of folders) {
    const path = join(target, 'workers', folder, 'worker.config.json');
    const original = parseJson(await readFile(path, 'utf8'));
    const rebound = rebindBoundaryConfig(original, source, config, flags);
    const { name } = object(rebound);
    if (typeof name !== 'string' || names.has(name)) {
      throw new Error('Workerが重複しています。');
    }
    names.add(name);
    await writeFile(path, JSON.stringify(rebound));
  }
  const modules = join(repositoryRoot, 'apps/web/node_modules');
  try {
    await symlink(modules, join(project, 'node_modules'), 'dir');
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error && error.code === 'EEXIST') ||
      (await readlink(join(project, 'node_modules'))) !== modules
    ) {
      throw error;
    }
  }
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(project, 'vite.config.ts'),
    `
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
export default defineConfig({ server: { ws: false }, plugins: [voidPlugin({ persistTo: ${JSON.stringify(config.stateDirectory)} })] });
`,
  );
  await writeFile(join(project, 'void.config.ts'), 'export default {};');
  return project;
}
