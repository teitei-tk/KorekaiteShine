import { expect, it } from 'vitest';
import { changedLines, isMaterialPath } from './material.ts';
it('hunkの新しい側の行を取り出し、削除行を新側の指摘位置にしない', () => {
  expect(changedLines('@@ -1,3 +1,3 @@\n same\n-old\n+new\n same\n')).toEqual([2]);
  expect(changedLines('@@ -1 +0,0 @@\n-old\n')).toEqual([]);
});
it('秘密値・生成物・ロック・エージェント設定を資料としても除外する', () => {
  for (const path of [
    '.env',
    '.env.production',
    'x/key.pem',
    '.codex/config.toml',
    'node_modules/a.ts',
    'pnpm-lock.yaml',
    'dist/app.js',
  ]) {
    expect(isMaterialPath(path)).toBe(false);
  }
  for (const path of [
    'src/app.tsx',
    'docs/spec/mvp.md',
    'AGENTS.md',
    '.github/workflows/docs.yml',
  ]) {
    expect(isMaterialPath(path)).toBe(true);
  }
});

it('baseとheadで同じ内容の資料を二重送信しない', async () => {
  const { snapshotFiles } = await import('./material.ts');
  const blob = 'a'.repeat(40);
  const reserved: string[] = [];
  const read = (...args: string[]) =>
    args[0] === 'ls-tree' ? `100644 blob ${blob}\tapp.ts\0` : 'export const value = 1;';
  const files = snapshotFiles(read, ['base', 'head'], (text) => reserved.push(text));
  expect(files).toEqual([
    { revisions: ['base', 'head'], path: 'app.ts', content: 'export const value = 1;' },
  ]);
  expect(reserved).toEqual(['export const value = 1;']);
});
