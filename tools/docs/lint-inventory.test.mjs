import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
const originalArgs = [...process.argv];
const originalExit = process.exitCode;
const rule = { scope: 'eslint', value: 'fixture', category: 'correctness', type_aware: false };
const row = {
  rule: 'eslint/fixture',
  status: 'enabled',
  category: 'correctness',
  typeAware: false,
};
const state = { configuration: {}, exceptions: {}, scopes: [], inventory: [] };
beforeEach(() => {
  vi.resetModules();
  process.exitCode = undefined;
  process.argv = originalArgs.slice(0, 2);
  state.configuration = { overrides: [{ files: ['*.ts'] }], rules: {} };
  state.exceptions = {};
  state.scopes = [];
  state.inventory = [row];
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify([rule]));
  vi.mocked(readFileSync).mockImplementation((path) =>
    JSON.stringify(
      {
        '.oxlintrc.json': state.configuration,
        'tools/lint/rule-exceptions.json': state.exceptions,
        'tools/lint/scoped-exceptions.json': state.scopes,
        'tools/lint/rule-inventory.json': state.inventory,
        'custom.json': state.inventory,
      }[path],
    ),
  );
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  process.argv = originalArgs;
  process.exitCode = originalExit;
  vi.restoreAllMocks();
});
test('現在の規則と台帳が一致した場合だけ成功する', async () => {
  await import('../lint/check-rule-inventory.mjs');
  expect(process.exitCode).toBeUndefined();
  expect(console.log).toHaveBeenCalledWith('oxlint規則台帳: 1件を確認しました。');
});
test('名前空間・配列severity・局所例外と全体例外の理由を照合する', async () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify([{ ...rule, scope: 'react_perf' }]));
  state.inventory = [{ ...row, rule: 'react_perf/fixture', status: 'exception', reason: 'reason' }];
  state.configuration = {
    rules: { 'react-perf/fixture': ['off'] },
    overrides: [{ files: ['b', 'a'], rules: { fixture: 'off' } }],
  };
  state.exceptions = { 'react-perf/fixture': 'reason' };
  state.scopes = [{ files: ['a', 'b'], rules: { fixture: 'off' }, reason: 'reason' }];
  process.argv.push('custom.json');
  await import('../lint/check-rule-inventory.mjs');
  expect(process.exitCode).toBeUndefined();
});
test.each([
  [
    '未分類',
    () => {
      state.inventory = [];
    },
  ],
  [
    '有効設定と分類',
    () => {
      state.inventory = [{ ...row, status: 'exception', reason: 'reason' }];
    },
  ],
  [
    '仕様変更',
    () => {
      state.inventory = [{ ...row, category: 'style' }];
    },
  ],
  [
    '仕様変更',
    () => {
      state.inventory = [{ ...row, typeAware: true }];
    },
  ],
  [
    '不正な分類',
    () => {
      state.inventory = [{ ...row, status: 'invalid' }];
    },
  ],
  [
    '分類理由',
    () => {
      state.inventory = [{ ...row, status: 'scoped' }];
    },
  ],
  [
    '削除された',
    () => {
      state.inventory = [row, { ...row, rule: 'eslint/removed' }];
    },
  ],
  [
    '重複',
    () => {
      state.inventory = [row, row];
    },
  ],
  [
    '例外理由',
    () => {
      state.configuration.rules = { fixture: 'off' };
    },
  ],
  [
    '局所例外の理由',
    () => {
      state.configuration.overrides = [{ files: ['x'], rules: { fixture: 'off' } }];
    },
  ],
  [
    '設定に存在しない',
    () => {
      state.scopes = [{ files: ['x'], rules: { fixture: 'off' }, reason: 'reason' }];
    },
  ],
  [
    '対象・規則・理由',
    () => {
      state.scopes = [{ files: ['x'], rules: { fixture: 'off' }, reason: 1 }];
    },
  ],
  [
    '対象・規則・理由',
    () => {
      state.scopes = [{ files: ['x'], rules: { fixture: 'off' }, reason: ' ' }];
    },
  ],
  [
    '対象・規則・理由',
    () => {
      state.scopes = [{ files: [], rules: { fixture: 'off' }, reason: 'reason' }];
    },
  ],
  [
    '対象・規則・理由',
    () => {
      state.scopes = [{ files: ['x'], rules: {}, reason: 'reason' }];
    },
  ],
])('%sが不正なら検査を失敗させる', async (message, configure) => {
  configure();
  await import('../lint/check-rule-inventory.mjs');
  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining(message));
  expect(console.log).not.toHaveBeenCalled();
});
