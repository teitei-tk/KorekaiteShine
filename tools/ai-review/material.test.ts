import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFromGit, changedLines } from './material.ts';
it('追加行だけを投稿候補にする', () =>
  expect(changedLines('@@ -1,2 +1,3 @@\n same\n+new\n-old\n+newer')).toEqual([2, 3]));
it('原文への参照と全差分行を準備し独自分割を作らない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-material-'));
  const pr = {
    number: 1,
    user: { id: 1324680, type: 'User' },
    state: 'open',
    draft: false,
    head: { sha: 'a'.repeat(40), repo: { id: 1426899426 } },
    base: { sha: 'b'.repeat(40), ref: 'main', repo: { id: 1426899426 } },
  };
  const git = (...args: string[]) =>
    args[0] === 'merge-base'
      ? 'c'.repeat(40)
      : args.includes('--name-only')
        ? 'a.rs\0'
        : args[0] === 'diff'
          ? '@@ -0,0 +1 @@\n+bug\n'
          : '';
  try {
    const result = collectFromGit(pr, dir, git, { issues: [], inline: [], threads: [] }, '4');
    expect(result.version).toBe(2);
    expect(result.lines['a.rs']).toEqual([1]);
    expect(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')).head).toBe(pr.head.sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
