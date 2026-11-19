import type * as FileSystem from 'node:fs/promises';
import { parseObject, objectAt } from './helpers/config-json.ts';
import type * as LintTypeModule0 from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { runtimeVersions } from '../src/versions.ts';

const boundary = vi.hoisted(() => ({
  paths: vi.fn<(from: string, name: string) => string[] | null>(),
}));
vi.mock('node:module', () => ({
  createRequire: (from: string) => ({
    resolve: { paths: (name: string) => boundary.paths(from, name) },
  }),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FileSystem>();
  return { ...original, readFile: vi.fn(original.readFile) };
});
afterEach(() => vi.resetAllMocks());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'korekaite-versions-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'void'));
  boundary.paths.mockReturnValue([root]);
  return join(root, 'void/package.json');
}

test('別パッケージのmanifestを依存版の証拠として採用しない', async () => {
  await writeFile(await fixture(), JSON.stringify({ name: 'other', version: '1.0.0' }));
  await expect(runtimeVersions()).rejects.toThrow('DEPENDENCY_VERSION_NOT_FOUND');
});

test('版が文字列でないmanifestを依存版の証拠として採用しない', async () => {
  await writeFile(await fixture(), JSON.stringify({ name: 'void', version: 1 }));
  await expect(runtimeVersions()).rejects.toThrow('DEPENDENCY_VERSION_NOT_FOUND');
});

test('manifestを読み取れない異常は依存の不在に置き換えず呼び出し元へ返す', async () => {
  const manifest = await fixture();
  await symlink('package.json', manifest);
  await expect(runtimeVersions()).rejects.toMatchObject({ code: 'ELOOP' });
});

test('実際の依存解決位置から固定版とロックファイルの証拠を取得する', async () => {
  const actual = await vi.importActual<typeof LintTypeModule0>('node:module');
  boundary.paths.mockImplementation((from: string, name: string) =>
    actual.createRequire(from).resolve.paths(name),
  );
  const versions = await runtimeVersions();
  const manifest = parseObject(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  expect(versions).toMatchObject({
    node: process.version,
    void: objectAt(manifest.dependencies).void,
    vite: objectAt(manifest.devDependencies).vite,
  });
  expect(versions.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/u);
  expect(versions.cloudflareVite).toMatch(/^\d+\.\d+\.\d+/u);
  expect(versions.miniflare).toMatch(/^\d+\.\d+\.\d+/u);
  expect(versions.lockfileSha256).toMatch(/^[a-f0-9]{64}$/u);
});

test('検索先の欠落とオブジェクトでないmanifestを拒否する', async () => {
  boundary.paths.mockReturnValue(null);
  await expect(runtimeVersions()).rejects.toThrow('必須値');
  await writeFile(await fixture(), 'null');
  await expect(runtimeVersions()).rejects.toThrow('JSONオブジェクト');
});

test('packageManagerが欠けたルートmanifestを証拠として採用しない', async () => {
  const actualModule = await vi.importActual<typeof LintTypeModule0>('node:module');
  const actualFs = await vi.importActual<typeof FileSystem>('node:fs/promises');
  boundary.paths.mockImplementation((from, name) =>
    actualModule.createRequire(from).resolve.paths(name),
  );
  const rootManifest = new URL('../../../package.json', import.meta.url).pathname;
  vi.mocked(readFile).mockImplementation((path, options) =>
    path === rootManifest ? Promise.resolve('{}') : actualFs.readFile(path, options),
  );
  await expect(runtimeVersions()).rejects.toThrow('PACKAGE_MANAGER_NOT_FOUND');
});
