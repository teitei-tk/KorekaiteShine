import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function dependency(
  name: 'void' | '@cloudflare/vite-plugin' | 'miniflare' | 'vite',
  from: string,
): Promise<{ path: string; version: string }> {
  // 組込みモジュールではない固定依存名なので、Nodeは検索先の配列を返す。
  for (const directory of createRequire(from).resolve.paths(name)!) {
    try {
      const path = await realpath(join(directory, name, 'package.json'));
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      if (manifest.name === name && typeof manifest.version === 'string') {
        return { path, version: manifest.version };
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }
  throw new Error('DEPENDENCY_VERSION_NOT_FOUND');
}

export async function runtimeVersions(): Promise<Record<string, string>> {
  const from = join(repositoryRoot, 'tools/local-integration/package.json');
  const framework = await dependency('void', from);
  const plugin = await dependency('@cloudflare/vite-plugin', framework.path);
  const miniflare = await dependency('miniflare', plugin.path);
  const vite = await dependency('vite', from);
  const root = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  return {
    node: process.version,
    packageManager: root.packageManager,
    void: framework.version,
    cloudflareVite: plugin.version,
    miniflare: miniflare.version,
    vite: vite.version,
    lockfileSha256: createHash('sha256')
      .update(await readFile(join(repositoryRoot, 'pnpm-lock.yaml')))
      .digest('hex'),
  };
}
