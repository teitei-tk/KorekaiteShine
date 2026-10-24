import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { checkLinks } from './check.ts';

async function fixture(contents: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'korekaite-doc-links-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(contents))
    await writeFile(path.join(root, name), source);
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
