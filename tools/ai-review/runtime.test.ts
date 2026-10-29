import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ uid: 1001, symlink: false, mode: 0o644 }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  lstatSync: () => ({
    uid: state.uid,
    mode: state.mode,
    isSymbolicLink: () => state.symlink,
    isDirectory: () => false,
  }),
  chownSync: vi.fn((_path: string, uid: number) => {
    state.uid = uid;
  }),
  chmodSync: vi.fn((_path: string, mode: number) => {
    state.mode = mode;
  }),
}));
import { chownSync, chmodSync } from 'node:fs';
import { protectTree } from './runtime.ts';
it('コピー元のrunner所有が残るファイルもroot所有・読取専用へ固定する', () => {
  state.uid = 1001;
  state.symlink = false;
  state.mode = 0o666;
  protectTree('/context/history.json');
  expect(state.uid).toBe(0);
  expect(state.mode).toBe(0o644);
});
it('PRのシンボリックリンクを辿って参照先の所有者・権限を変えない', () => {
  vi.mocked(chownSync).mockClear();
  vi.mocked(chmodSync).mockClear();
  state.symlink = true;
  protectTree('/pr/link');
  expect(chownSync).not.toHaveBeenCalled();
  expect(chmodSync).not.toHaveBeenCalled();
});
