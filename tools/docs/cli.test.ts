import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';

async function fixture(contents: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'korekaite-doc-cli-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const files = {
    'README.md': '# 案内\n',
    '.markdownlint.json': JSON.stringify({ default: false, MD001: true, MD047: true }),
    '.node-version': '26.12.1\n',
    'package.json': JSON.stringify({ engines: { node: '>=26 <27' }, scripts: { test: 'unused' } }),
    ...contents,
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), content);
  }
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}
function invoke(name: string, root?: string, env = process.env) {
  const script = new URL(name, import.meta.url);
  const args =
    root === undefined
      ? [fileURLToPath(script)]
      : [
          '--input-type=module',
          '--eval',
          `const { main } = await import(${JSON.stringify(script.href)}); await main(${JSON.stringify(root)});`,
        ];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000, env });
  if (result.error) {
    throw result.error;
  }
  return result;
}

test('文書検査は指定したGitリポジトリを検査し成功を終了コードで返す', async () => {
  const result = invoke('./check.ts', await fixture());
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('文書検査成功: Markdown 1件');
  expect(result.stderr).toBe('');
});

test('文書の書式違反は詳細の有無にかかわらず行と規則を報告して失敗する', async () => {
  const result = invoke(
    './check.ts',
    await fixture({ 'README.md': '# 案内\n\n### 飛ばした見出し' }),
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('README.md:3: MD001');
  expect(result.stderr).toContain('README.md:3: MD047');
  expect(result.stdout).not.toContain('検査成功');
});

test('リンク切れはCLIの終了コード1と文書内の位置で報告する', async () => {
  const result = invoke(
    './check.ts',
    await fixture({ 'README.md': '# 案内\n\n[不在](missing.md)\n' }),
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('README.md:3: ファイルが存在しない: missing.md');
  expect(result.stdout).not.toContain('検査成功');
});

test('存在しないpnpmスクリプトの参照はCLIで失敗する', async () => {
  const result = invoke('./check.ts', await fixture({ 'README.md': '# 案内\n\n`pnpm absent`\n' }));
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('README.md:3: スクリプトが存在しない: absent');
  expect(result.stdout).not.toContain('検査成功');
});

test('Node設定の検査も指定したリポジトリの整合性を終了コードで返す', async () => {
  const result = invoke('./check-node.ts', await fixture());
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Node.js設定の整合性検査成功');
  expect(result.stderr).toBe('');
});

test('Node版とengineの不整合はCLIで失敗する', async () => {
  const result = invoke(
    './check-node.ts',
    await fixture({
      'package.json': '{"engines":{"node":"<22"}}',
    }),
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('package.json: engines.node (<22)');
  expect(result.stdout).not.toContain('検査成功');
});

test('通常の文書CLI入口は既定のリポジトリを検査する', () => {
  const result = invoke('./check.ts');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/文書検査成功: Markdown \d+件/);
  expect(result.stderr).toBe('');
});

test('通常のNode設定CLI入口は既定のリポジトリを検査する', () => {
  const result = invoke('./check-node.ts');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Node.js設定の整合性検査成功');
  expect(result.stderr).toBe('');
});

test('Git列挙の失敗を文書・Node設定CLIとも成功扱いしない', async () => {
  const emptyPath = await fixture();
  for (const name of ['./check.ts', './check-node.ts']) {
    const result = invoke(name, undefined, { ...process.env, PATH: emptyPath });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('spawnSync git ENOENT');
    expect(result.stdout).not.toContain('検査成功');
  }
});

test('Git管理対象でも削除済みの文書は検査対象から外す', async () => {
  const root = await fixture({ 'deleted.md': '# 削除予定\n' });
  execFileSync('git', ['add', 'deleted.md'], { cwd: root });
  await rm(join(root, 'deleted.md'));
  const result = invoke('./check.ts', root);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('文書検査成功: Markdown 1件');
});

test('文書の参照がループする場合は削除済みと扱わず検査を失敗させる', async () => {
  const root = await fixture();
  await symlink('loop.md', join(root, 'loop.md'));
  const result = invoke('./check.ts', root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ELOOP');
  expect(result.stdout).not.toContain('検査成功');
});

test('Node設定CLIはError以外の失敗も文字列として報告して終了する', async () => {
  const root = await fixture();
  const preload = join(root, 'read-failure.mjs');
  await writeFile(
    preload,
    `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readFile;
fs.readFile = (...args) => String(args[0]).endsWith('/.node-version')
  ? Promise.reject('fixture failure') : original(...args);
syncBuiltinESMExports();
`,
  );
  const result = spawnSync(
    process.execPath,
    ['--import', preload, fileURLToPath(new URL('./check-node.ts', import.meta.url))],
    { encoding: 'utf8', timeout: 10_000 },
  );
  if (result.error) {
    throw result.error;
  }
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr.trim()).toBe('fixture failure');
  expect(result.stdout).toBe('');
});
