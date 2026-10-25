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
  const { indexSources } = await import('./source-index.ts');
  const blob = 'a'.repeat(40);
  let reads = 0;
  const read = (...args: string[]) => {
    if (args[0] === 'ls-tree') return `100644 blob ${blob}\tapp.ts\0`;
    reads++;
    return 'export const value = 1;';
  };
  const index = indexSources(read, ['base', 'head']);
  expect(index.files[0].sources[0]).toMatchObject({
    revisions: ['base', 'head'],
    path: 'app.ts',
    content: 'export const value = 1;',
  });
  expect(reads).toBe(1);
});
