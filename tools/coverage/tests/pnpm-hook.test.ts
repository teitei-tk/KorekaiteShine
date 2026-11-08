import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
function readPackage(name: string, version: string) {
  const path = fileURLToPath(new URL('../../../.pnpmfile.cjs', import.meta.url));
  const pkg = { name, version, peerDependencies: { typescript: '*' }, dependencies: {} };
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `const {hooks}=require(${JSON.stringify(path)}); console.log(JSON.stringify(hooks.readPackage(${JSON.stringify(pkg)})));`,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}
test('固定版の型生成器だけCompiler APIを5系へ分離する', () => {
  expect(readPackage('openapi-typescript', '7.13.0')).toMatchObject({
    peerDependencies: {},
    dependencies: { typescript: '5.9.3' },
  });
});
test('別パッケージと別バージョンのCompiler API指定は変更しない', () => {
  for (const [name, version] of [
    ['other', '7.13.0'],
    ['openapi-typescript', '8.0.0'],
  ]) {
    expect(readPackage(name!, version!)).toMatchObject({
      peerDependencies: { typescript: '*' },
      dependencies: {},
    });
  }
});
