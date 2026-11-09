import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { collect, collectFromGit } from './material.ts';

const state = vi.hoisted(() => ({ fail: false }));
vi.mock('node:child_process', async () => {
  const { writeSync } = await import('node:fs');
  return {
    execFileSync: vi.fn(
      (_program: string, args: string[], options: { stdio: [string, number, string] }) => {
        if (state.fail) {
          throw new Error('git failed');
        }
        const output = args.includes('merge-base')
          ? 'c'.repeat(40)
          : args.includes('--name-only')
            ? 'a.ts\0'
            : args.includes('diff')
              ? '@@ -0,0 +1 @@\n+line\n'
              : '';
        writeSync(options.stdio[1], output);
        return '';
      },
    ),
  };
});
afterEach(() => {
  state.fail = false;
  vi.clearAllMocks();
});

it('比較元SHAを確定できなければ差分資料へ進まない', () => {
  const f = fixture();
  const git = vi.fn(() => 'invalid');
  expect(() => collectFromGit(f.pr, f.directory, git, f.history, '12')).toThrow(
    '比較元を確定できません',
  );
  expect(git).toHaveBeenCalledTimes(1);
});

it('Git実行が失敗しても一時出力を残さず資料を作らない', () => {
  const f = fixture();
  state.fail = true;
  expect(() => collect(f.pr, f.directory, f.history, '12')).toThrow('git failed');
  expect(existsSync(join(f.directory, 'git-output'))).toBe(false);
  expect(existsSync(join(f.directory, 'metadata.json'))).toBe(false);
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'material-boundary-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const pr = {
    number: 7,
    state: 'open',
    draft: false,
    user: { id: 1324680, type: 'User' },
    head: { sha: 'a'.repeat(40), repo: { id: 1426899426 } },
    base: { sha: 'b'.repeat(40), ref: 'main', repo: { id: 1426899426 } },
    title: 'title',
    body: 'body',
  };
  return { directory, pr, history: { issues: [], inline: [], threads: [] } };
}

it('Git資料収集は固定remoteと無効化したhooksを使い一時出力を削除する', () => {
  const f = fixture();
  const result = collect(f.pr, f.directory, f.history, '12');
  expect(result.lines).toEqual({ 'a.ts': [1] });
  expect(execFileSync).toHaveBeenCalledWith(
    'git',
    expect.arrayContaining([
      'core.hooksPath=/dev/null',
      'fetch',
      'https://github.com/teitei-tk/KorekaiteShine.git',
    ]),
    expect.objectContaining({
      env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' }),
    }),
  );
  expect(existsSync(join(f.directory, 'git-output'))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.directory, 'request.json'), 'utf8'))).toMatchObject({
    title: 'title',
    body: 'body',
  });
});
