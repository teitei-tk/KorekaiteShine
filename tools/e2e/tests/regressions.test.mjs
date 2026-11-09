import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { execute, temp } = vi.hoisted(() => ({ execute: vi.fn(), temp: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: execute }));
vi.mock('node:os', async (original) => ({ ...(await original()), tmpdir: temp }));
let root;
const originalArgs = process.argv;
beforeEach(async () => {
  root = realpathSync(
    mkdtempSync(join((await vi.importActual('node:os')).tmpdir(), 'voice-snapshot-test-')),
  );
  temp.mockReturnValue(root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgs;
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});
function source(files) {
  const dir = join(root, 'source');
  mkdirSync(join(dir, 'packages/api-contracts/generated'), { recursive: true });
  for (const name of files.filter((name) => name !== 'deleted')) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{}');
  }
  execute.mockImplementation((command, args) => {
    if (command === 'git' && args.includes('rev-parse')) {
      return dir;
    }
    if (command === 'git' && args.includes('ls-files')) {
      return [...files, 'deleted', ''].join('\0');
    }
    return '';
  });
  return dir;
}
test.each([undefined, 'audio-event', 'upgrade'])(
  '安全な原本と依存リンクをコピーし原因別パッチを選ぶ (%s)',
  async (cause) => {
    const files = [
      'packages/api-contracts/package.json',
      'tools/helper/package.json',
      'regular',
      '.env.local',
    ];
    const dir = source(files);
    mkdirSync(join(dir, 'node_modules/@korekaite'), { recursive: true });
    symlinkSync(
      join(dir, 'packages/api-contracts'),
      join(dir, 'node_modules/@korekaite/api-contracts'),
    );
    mkdirSync(join(dir, 'node_modules/example'));
    process.argv = ['node', 'snapshot', dir, ...(cause ? [cause] : [])];
    await import('../regressions/snapshot.mjs');
    const copy = console.log.mock.lastCall[0];
    expect(readFileSync(join(copy, 'regular'), 'utf8')).toBe('{}');
    expect(existsSync(join(copy, '.env.local'))).toBe(false);
    expect(realpathSync(join(copy, 'node_modules/@korekaite/api-contracts'))).toBe(
      join(copy, 'packages/api-contracts'),
    );
    expect(realpathSync(join(copy, 'node_modules/example'))).toBe(
      join(dir, 'node_modules/example'),
    );
    if (cause) {
      expect(execFileSync.mock.calls.some(([, args]) => args.includes(cause))).toBe(true);
    }
    expect(
      execFileSync.mock.calls.some(([, args]) => args.includes('scripts/generate-events.ts')),
    ).toBe(cause === 'audio-event');
  },
);
test.each(['missing', 'extra', 'subdir', 'symlink', 'bad-dependency', 'missing-package'])(
  '無効なコピーを拒否し一時領域を片付ける (%s)',
  async (kind) => {
    const dir = source(['file']);
    if (kind === 'symlink') {
      rmSync(join(dir, 'file'));
      symlinkSync(dir, join(dir, 'file'));
    }
    if (['bad-dependency', 'missing-package'].includes(kind)) {
      const target = join(dir, kind === 'bad-dependency' ? 'tools/bad' : 'packages/bad');
      mkdirSync(target, { recursive: true });
      mkdirSync(join(dir, 'node_modules/@korekaite'), { recursive: true });
      symlinkSync(target, join(dir, 'node_modules/@korekaite/bad'));
    }
    process.argv = [
      'node',
      'snapshot',
      ...(kind === 'missing' ? [] : [kind === 'subdir' ? join(dir, 'packages') : dir]),
      ...(kind === 'extra' ? ['one', 'two'] : []),
    ];
    await expect(import('../regressions/snapshot.mjs')).rejects.toThrow();
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(root)).toEqual(['source']);
  },
);
test.each(['missing', 'unknown', 'outside', 'git', 'valid'])(
  '回帰パッチの適用先を制限し、事前検査を通して適用する (%s)',
  async (kind) => {
    const dir = join(root, 'copy');
    mkdirSync(dir);
    if (kind === 'git') {
      mkdirSync(join(dir, '.git'));
    }
    process.argv = [
      'node',
      'apply',
      ...(kind === 'missing'
        ? []
        : [kind === 'outside' ? process.cwd() : dir, kind === 'unknown' ? 'other' : 'upgrade']),
    ];
    if (kind === 'valid') {
      await import('../regressions/apply.mjs');
      expect(execFileSync.mock.calls.map(([, args]) => args.slice(0, -1))).toEqual([
        ['apply', '--check'],
        ['apply'],
      ]);
    } else {
      await expect(import('../regressions/apply.mjs')).rejects.toThrow();
      expect(execFileSync).not.toHaveBeenCalled();
    }
  },
);
