import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import test from 'node:test';

test('生成専用のTypeScript環境でHTTP契約から名前付きモデルとFetch SDKを生成できる', () => {
  const directory = new URL('../../packages/api-contracts/generated/http/client/', import.meta.url);
  const publicDirectory = new URL(
    '../../packages/api-contracts/generated/http/public-client/',
    import.meta.url,
  );
  rmSync(publicDirectory, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
  execFileSync('pnpm', ['generate'], { cwd: import.meta.dirname, stdio: 'pipe' });
  assert.ok(existsSync(new URL('types.gen.ts', directory)), '名前付きモデルが生成される');
  const types = readFileSync(new URL('types.gen.ts', directory), 'utf8');
  assert.match(types, /export type Interview\b/);
  assert.match(types, /id: string/);
  const sdk = readFileSync(new URL('sdk.gen.ts', directory), 'utf8');
  assert.match(sdk, /export const listInterviews\b/);
  assert.match(sdk, /export const startCheckJob\b/);
  assert.match(sdk, /export const getCheckJob\b/);
  const publicSdk = readFileSync(new URL('sdk.gen.ts', publicDirectory), 'utf8');
  assert.match(publicSdk, /export const listInterviews\b/);
  assert.doesNotMatch(publicSdk, /diagnostics|startCheckJob|getCheckJob/);
});
