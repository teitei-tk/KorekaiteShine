import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { checkLinks, checkCommands } from './check.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});
afterEach(() => vi.resetAllMocks());

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'korekaite-doc-errors-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), source);
  vi.mocked(realpath).mockResolvedValueOnce(root).mockRejectedValueOnce('fixture failure');
  return root;
}

test('リンクのファイル境界が文字列をthrowしても位置付きの検査エラーにする', async () => {
  const root = await fixture('# 案内\n\n[参照](target.md)\n');
  expect(await checkLinks(root, ['README.md'])).toEqual([
    'README.md:3: fixture failure: target.md',
  ]);
});

test('package.jsonのファイル境界が文字列をthrowしても検査エラーにする', async () => {
  const root = await fixture('# 案内\n\n`pnpm test`\n');
  expect(await checkCommands(root, ['README.md'])).toEqual([
    'README.md:3: package.jsonの検査に失敗',
  ]);
});
