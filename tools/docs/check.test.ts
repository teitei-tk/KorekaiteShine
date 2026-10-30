import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { checkLinks, checkCommands } from './check.ts';

async function fixture(contents: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'korekaite-doc-links-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), source);
  }
  return root;
}

test('日本語・装飾・コード・重複見出しと参照形式リンクを解決する', async () => {
  const root = await fixture({
    'README.md':
      '# 案内\n\n[参照][target]\n\n[target]: <用語 集.md#判断の根拠-1>\n\n[先頭](用語%20集.md#%E5%88%A4%E6%96%AD%E3%81%AE%E6%A0%B9%E6%8B%A0)\n',
    '用語 集.md': '# **判断**の`根拠`\n\n## 判断の根拠\n',
  });
  expect(await checkLinks(root, ['README.md', '用語 集.md'])).toEqual([]);
});

test('同一文書アンカーとSetext見出し、画像を確認する', async () => {
  const root = await fixture({
    'README.md': '案内\n====\n\n[戻る](#案内)\n\n![図](image.svg)\n',
    'image.svg': '<svg/>',
  });
  expect(await checkLinks(root, ['README.md'])).toEqual([]);
});

test('ファイル欠落と見出し欠落を別々に報告する', async () => {
  const root = await fixture({
    'README.md': '# 案内\n\n[欠落](missing.md)\n\n[誤字](target.md#違う見出し)\n',
    'target.md': '# 正しい見出し\n',
  });
  const errors = await checkLinks(root, ['README.md']);
  expect(errors).toHaveLength(2);
  expect(errors[0]).toMatch(/ファイルが存在しない/);
  expect(errors[1]).toMatch(/見出しが存在しない/);
});

test('コード例と外部URLはリンク検査の対象外', async () => {
  const root = await fixture({
    'README.md':
      '# 案内\n\n```md\n[例](missing.md)\n```\n\n`[例](missing.md)`\n\n[外部](https://example.invalid/)\n',
  });
  expect(await checkLinks(root, ['README.md'])).toEqual([]);
});

test('リポジトリ外への相対パスを拒否する', async () => {
  const root = await fixture({ 'README.md': '# 案内\n\n[外](../outside.md)\n' });
  const errors = await checkLinks(root, ['README.md']);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/リポジトリ外/);
});

test('表内のリンクを検査し、欠落箇所の行を報告する', async () => {
  const root = await fixture({
    'README.md': '# 案内\n\n| 資料 |\n| --- |\n| [有効](#案内) |\n| [欠落](missing.md) |\n',
  });
  const errors = await checkLinks(root, ['README.md']);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/README.md:6: ファイルが存在しない/);
});

test('ルート・子パッケージの省略形とrun形式を照合し、引数を実行しない', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ scripts: { check: 'exit 99' } }),
    'tools/example/package.json': JSON.stringify({ scripts: { test: 'exit 99' } }),
    'README.md':
      '`pnpm check --flag`\n\n```sh\npnpm run check\npnpm --dir tools/example test\npnpm --dir tools/example run test\n```\n',
  });
  expect(await checkCommands(root, ['README.md'])).toEqual([]);
});

test('削除されたスクリプトと誤ったパッケージの行を報告する', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ scripts: { check: 'true' } }),
    'README.md': '# 案内\n\n`pnpm missing`\n\n```bash\npnpm --dir missing test\n```\n',
  });
  const errors = await checkCommands(root, ['README.md']);
  expect(errors).toHaveLength(2);
  expect(errors[0]).toMatch(/README.md:3:.*スクリプト/);
  expect(errors[1]).toMatch(/README.md:6:.*package.json/);
});

test('組み込みコマンド、通常の文章、非シェルのコード例は対象外', async () => {
  const root = await fixture({
    'README.md':
      'pnpm の説明\n\n`pnpm install --ignore-scripts` `pnpm exec tool` `pnpm run <script>`\n\n```md\npnpm missing\n```\n',
  });
  expect(await checkCommands(root, ['README.md'])).toEqual([]);
});

test('表内のコマンド欠落を報告し、Objectの継承プロパティを許可しない', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ scripts: {} }),
    'README.md': '| 操作 |\n| --- |\n| `pnpm toString` |\n',
  });
  expect(await checkCommands(root, ['README.md'])).toEqual([
    'README.md:3: スクリプトが存在しない: toString (package.json)',
  ]);
});

test('リポジトリ外のパッケージ参照を拒否する', async () => {
  const root = await fixture({ 'README.md': '`pnpm --dir ../outside test`' });
  expect((await checkCommands(root, ['README.md']))[0]).toMatch(/リポジトリ外/);
});

test('未対応オプションと引用付きパスをスクリプト欠落として誤検知しない', async () => {
  const commands = [
    'pnpm --filter example test',
    'pnpm -r test',
    'pnpm --dir "tools/docs" test',
    "pnpm --dir 'tools/docs' test",
    'pnpm --dir=tools/docs test',
    'pnpm --dir tools/docs --filter example test',
    'pnpm run --if-present missing',
  ];
  const root = await fixture({
    'README.md': commands.map((command) => `\`${command}\``).join('\n\n'),
  });
  expect(await checkCommands(root, ['README.md'])).toEqual([]);
});

test('ドットを含む名前を省略形・run形式・子パッケージで完全に照合する', async () => {
  const commands = [
    'pnpm check.present',
    'pnpm run check.present',
    'pnpm missing.script',
    'pnpm run missing.script',
    'pnpm --dir tools/example check.present',
    'pnpm --dir tools/example run check.present',
    'pnpm --dir tools/example missing.script',
    'pnpm --dir tools/example run missing.script',
  ];
  const root = await fixture({
    'package.json': JSON.stringify({ scripts: { 'check.present': 'exit 99', missing: 'exit 99' } }),
    'tools/example/package.json': JSON.stringify({
      scripts: { 'check.present': 'exit 99', missing: 'exit 99' },
    }),
    'README.md': '```sh\n' + commands.join('\n') + '\n```\n',
  });
  const errors = await checkCommands(root, ['README.md']);
  expect(errors).toEqual([
    'README.md:4: スクリプトが存在しない: missing.script (package.json)',
    'README.md:5: スクリプトが存在しない: missing.script (package.json)',
    'README.md:8: スクリプトが存在しない: missing.script (tools/example/package.json)',
    'README.md:9: スクリプトが存在しない: missing.script (tools/example/package.json)',
  ]);
});

test('removeの別名は組み込み操作として除外し、runで明示した同名スクリプトは検査する', async () => {
  const aliases = ['rm', 'uninstall', 'un', 'uni'];
  const root = await fixture({
    'package.json': JSON.stringify({ scripts: {} }),
    'README.md': '```sh\n' + aliases.map((alias) => `pnpm ${alias} example`).join('\n') + '\n```\n',
  });
  expect(await checkCommands(root, ['README.md'])).toEqual([]);
  await writeFile(path.join(root, 'README.md'), '`pnpm run uninstall`\n');
  expect(await checkCommands(root, ['README.md'])).toEqual([
    'README.md:1: スクリプトが存在しない: uninstall (package.json)',
  ]);
});
