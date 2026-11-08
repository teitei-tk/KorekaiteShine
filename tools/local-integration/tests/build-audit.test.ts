import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, onTestFinished, test } from 'vitest';
import { buildAudit, type BuildAudit } from '../src/build-audit.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'korekaite-build-audit-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'audit');
  const hook = buildAudit(directory).writeBundle;
  if (typeof hook !== 'function') {
    throw new Error('ビルド監査のフックがありません。');
  }
  const info = { importedIds: ['external'], dynamicallyImportedIds: ['lazy'], isEntry: true };
  const context = {
    environment: { name: 'client', config: { root } },
    getModuleIds: () => ['entry'],
    getModuleInfo: (): typeof info | null => info,
  };
  const invoke = (options: { dir?: string }, bundle: object) =>
    hook.call(
      context as object as ThisParameterType<typeof hook>,
      options as Parameters<typeof hook>[0],
      bundle as Parameters<typeof hook>[1],
    );
  const report = async (): Promise<BuildAudit> =>
    JSON.parse(await readFile(join(directory, 'client.json'), 'utf8'));
  return { root, directory, context, invoke, report };
}

test('ビルド監査は出力された実ファイルのhashと静的・動的importの対応を保存する', async () => {
  const { root, invoke, report } = await fixture();
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/entry.js'), 'hello');
  await writeFile(join(root, 'dist/asset.txt'), 'hello');
  await invoke(
    {},
    {
      entry: {
        type: 'chunk',
        fileName: 'entry.js',
        modules: { entry: {} },
        code: 'stale in-memory code',
      },
      asset: { type: 'asset', fileName: 'asset.txt', source: 'stale in-memory asset' },
    },
  );
  const actual = await report();
  expect(actual).toEqual({
    environment: 'client',
    outputDirectory: join(root, 'dist'),
    modules: [{ id: 'entry', imports: ['external'], dynamicImports: ['lazy'], isEntry: true }],
    outputs: [
      {
        fileName: 'entry.js',
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        modules: ['entry'],
      },
      {
        fileName: 'asset.txt',
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        modules: [],
      },
    ],
  });
});

test('出力先が指定されていれば既定のdistではなく指定先を記録する', async () => {
  const { root, context, invoke, report } = await fixture();
  context.getModuleIds = () => [];
  await invoke({ dir: 'custom-output' }, {});
  expect(await report()).toEqual({
    environment: 'client',
    outputDirectory: join(root, 'custom-output'),
    modules: [],
    outputs: [],
  });
});

test('読み込んだモジュールの情報が欠けていれば不完全な監査を保存しない', async () => {
  const { context, invoke, report } = await fixture();
  context.getModuleInfo = () => null;
  await expect(invoke({}, {})).rejects.toThrow('モジュール情報がありません: entry');
  await expect(report()).rejects.toMatchObject({ code: 'ENOENT' });
});
