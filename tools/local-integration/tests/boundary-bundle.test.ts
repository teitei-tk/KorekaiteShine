import type { JsonValue } from '@korekaite/api-contracts/json';
import { expect, test, vi } from 'vitest';
import { buildRuntime } from '../src/runtime.ts';
import { resolveRuntime } from '@korekaite/runtime-config';
import { rebindBoundaryConfig } from '../src/boundary-bundle.ts';

vi.mock('../src/runtime.ts', () => ({ buildRuntime: vi.fn() }));

const source = resolveRuntime({
  repositoryRoot: '/workspace/example',
  appEnv: 'test',
  runId: 'bundle',
  parallelIndex: 0,
});
const target = resolveRuntime({
  repositoryRoot: '/workspace/example',
  appEnv: 'test',
  runId: 'case',
  parallelIndex: 1,
});

test('ビルド元の全接続先をケースへ再割当し、元の設定を変更しない', () => {
  const original = {
    name: source.workers.evaluation,
    env: {
      APP_ENV: { type: 'text', value: 'test' },
      DB: { type: 'd1', id: source.d1.id, name: source.d1.name },
      CHECK_OBJECT: { type: 'durable-object', worker: source.doOwner, exportName: 'CheckObject' },
      EVALUATION_QUEUE: { type: 'queue', name: source.queues.evaluation.queue },
      EVALUATION_QUEUE_NAME: { type: 'text', value: source.queues.evaluation.queue },
    },
    triggers: [
      {
        type: 'queue',
        name: source.queues.evaluation.queue,
        deadLetterQueue: source.queues.evaluation.dlq,
        retryDelay: 30,
      },
    ],
    manifest: { mainModule: 'index.js' },
  };
  const before = JSON.stringify(original);
  const result = rebindBoundaryConfig(original, source, target, {
    manualDiagnostics: true,
    probeOnlyEvaluation: true,
  });
  expect(result).toMatchObject({
    name: target.workers.evaluation,
    env: {
      DB: { id: target.d1.id, name: target.d1.name },
      CHECK_OBJECT: { worker: target.doOwner },
      EVALUATION_QUEUE: { name: target.queues.evaluation.queue },
      EVALUATION_QUEUE_NAME: { value: target.queues.evaluation.queue },
      BOUNDARY_MANUAL_DIAGNOSTICS: { type: 'text', value: 'true' },
      BOUNDARY_PROBE_ONLY_EVALUATION: { type: 'text', value: 'true' },
    },
    triggers: [
      {
        name: target.queues.evaluation.queue,
        deadLetterQueue: target.queues.evaluation.dlq,
        retryDelay: 30,
      },
    ],
    manifest: { mainModule: 'index.js' },
  });
  expect(JSON.stringify(original)).toBe(before);
  expect(() =>
    rebindBoundaryConfig(original, source, { ...target, environment: 'production' }, {}),
  ).toThrow();
  expect(() =>
    rebindBoundaryConfig({ ...original, name: 'unexpected-worker' }, source, target, {}),
  ).toThrow();
});

test('未知のbinding・Queue・DB・DO参照を共有成果物へ紛れ込ませない', () => {
  const base = {
    name: source.workers.web,
    env: {
      APP_ENV: { type: 'text', value: 'test' },
      DB: { type: 'd1', id: source.d1.id, name: source.d1.name },
    },
  };
  const bindings: JsonValue[] = [
    { type: 'queue', name: 'production-queue' },
    { type: 'durable-object', worker: 'production-worker' },
    { type: 'd1', id: 'production', name: 'production' },
    { type: 'r2' },
  ];
  for (const binding of bindings) {
    expect(() =>
      rebindBoundaryConfig({ ...base, env: { ...base.env, OTHER: binding } }, source, target, {}),
    ).toThrow();
  }
  expect(() =>
    rebindBoundaryConfig(
      { ...base, triggers: [{ type: 'queue', name: 'production-queue' }] },
      source,
      target,
      {},
    ),
  ).toThrow();
});

test('ケース側のコード・フラグ・保存先を分離し共有ビルドを変更しない', async () => {
  const { randomUUID } = await import('node:crypto');
  const { mkdir, readFile, rm, writeFile, symlink } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { stageBoundaryBundle, boundaryCoverageIdentity } =
    await import('../src/boundary-bundle.ts');
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const runId = randomUUID();
  const build = resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex: 0 });
  const a = resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex: 1 });
  const b = resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex: 2 });
  const directory = join(build.artifactDirectory, 'web');
  const output = '.cloudflare/output/v0';
  try {
    for (const name of Object.values(build.workers)) {
      const worker = join(directory, output, 'workers', name);
      await mkdir(join(worker, 'bundle'), { recursive: true });
      await writeFile(join(worker, 'bundle/index.js'), 'export default {};');
      await writeFile(
        join(worker, 'worker.config.json'),
        JSON.stringify({
          name,
          env: {
            APP_ENV: { type: 'text', value: 'test' },
            DB: { type: 'd1', id: build.d1.id, name: build.d1.name },
          },
        }),
      );
    }
    await writeFile(
      join(directory, 'boundary-bundle.json'),
      JSON.stringify({ schema: 1, runId, coverage: await boundaryCoverageIdentity() }),
    );
    const first = await stageBoundaryBundle(directory, a, { manualDiagnostics: true });
    const second = await stageBoundaryBundle(directory, b, {});
    const file = join(output, 'workers', build.workers.web, 'bundle/index.js');
    await writeFile(join(first, file), 'changed');
    expect(await readFile(join(directory, file), 'utf8')).toBe('export default {};');
    expect(await readFile(join(second, file), 'utf8')).toBe('export default {};');
    expect(await readFile(join(first, 'vite.config.ts'), 'utf8')).toContain(a.stateDirectory);
    expect(await readFile(join(second, 'vite.config.ts'), 'utf8')).toContain(b.stateDirectory);
    const configPath = join(output, 'workers', build.workers.web, 'worker.config.json');
    expect(await readFile(join(first, configPath), 'utf8')).toContain(a.d1.id);
    expect(await readFile(join(second, configPath), 'utf8')).toContain(b.d1.id);
    expect(await readFile(join(first, configPath), 'utf8')).toContain('"value":"true"');
    expect(await readFile(join(second, configPath), 'utf8')).not.toContain('"value":"true"');
    await writeFile(
      join(directory, 'boundary-bundle.json'),
      JSON.stringify({ schema: 1, runId, coverage: 'mismatched-run' }),
    );
    await expect(stageBoundaryBundle(directory, a, {})).rejects.toThrow();
    await writeFile(
      join(directory, 'boundary-bundle.json'),
      JSON.stringify({ schema: 1, runId, coverage: await boundaryCoverageIdentity() }),
    );
    await symlink(join(directory, file), join(directory, output, 'shared-link.js'));
    await expect(stageBoundaryBundle(directory, a, {})).rejects.toThrow();
  } finally {
    await rm(dirname(dirname(build.artifactDirectory)), { recursive: true, force: true });
  }
});

test('共有ビルド失敗時のログを削除しない', async () => {
  const { mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { createBoundaryBundle } = await import('../src/boundary-bundle.ts');
  const state = { directory: '' };
  const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.mocked(buildRuntime).mockImplementation(async (config) => {
    state.directory = config.artifactDirectory;
    await mkdir(state.directory, { recursive: true });
    await writeFile(join(state.directory, 'build.log'), 'fixture build failure');
    throw new Error('fixture build failure');
  });
  try {
    await expect(createBoundaryBundle()).rejects.toThrow();
    expect(await readFile(join(state.directory, 'build.log'), 'utf8')).toBe(
      'fixture build failure',
    );
    expect(output).toHaveBeenCalledWith(expect.stringContaining('fixture build failure'));
  } finally {
    vi.mocked(buildRuntime).mockReset();
    output.mockRestore();
    if (state.directory) {
      await rm(dirname(state.directory), { recursive: true, force: true });
    }
  }
});

test('共有ビルドの開始前から中断を監視してビルドへ渡し、リスナーを解放する', async () => {
  const { createBoundaryBundle } = await import('../src/boundary-bundle.ts');
  const controller = new AbortController();
  const ready = Promise.withResolvers<AbortSignal | undefined>();
  const listeners = process.listenerCount('SIGTERM');
  vi.mocked(buildRuntime).mockImplementation((_config, _options, signal) => {
    ready.resolve(signal);
    if (!signal) {
      return Promise.reject(new Error('signal missing'));
    }
    expect(process.listenerCount('SIGTERM')).toBe(listeners + 1);
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(new Error('build aborted'));
        },
        { once: true },
      );
    });
  });
  try {
    const pending = createBoundaryBundle(controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    const signal = await ready.promise;
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
  } finally {
    vi.mocked(buildRuntime).mockReset();
  }
});
