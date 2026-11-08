import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { runtimeVersions } from '../src/versions.ts';

const boundary = vi.hoisted(() => ({ paths: vi.fn() }));
vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  createRequire: (from: string) => ({
    resolve: { paths: (name: string) => boundary.paths(from, name) },
  }),
}));
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
  const actual = await vi.importActual<typeof import('node:module')>('node:module');
  boundary.paths.mockImplementation((from: string, name: string) =>
    actual.createRequire(from).resolve.paths(name),
  );
  const versions = await runtimeVersions();
  expect(versions).toMatchObject({ node: process.version, void: '1.6.2', vite: '8.3.5' });
  expect(versions.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  expect(versions.cloudflareVite).toMatch(/^\d+\.\d+\.\d+/);
  expect(versions.miniflare).toMatch(/^\d+\.\d+\.\d+/);
  expect(versions.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
});
