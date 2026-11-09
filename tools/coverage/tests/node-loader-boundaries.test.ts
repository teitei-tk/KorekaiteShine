import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import { prepareRun } from '../src/prepare.ts';
import { readCaptures } from '../src/capture.ts';

const loader = fileURLToPath(new URL('../src/node-loader.ts', import.meta.url));
function fixture(path: string, source: string) {
  const root = mkdtempSync(join(tmpdir(), 'coverage-loader-boundary-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, path), source);
  const { run } = prepareRun(root, [path], 'revision', ['node']);
  const directory = join(root, 'records');
  const config = join(root, 'run.json');
  writeFileSync(config, JSON.stringify({ root, directory, run }));
  return {
    root,
    directory,
    run,
    config,
    execute(code: string) {
      return spawnSync(process.execPath, ['--import', loader, '-e', code], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          KOREKAITE_COVERAGE_RUN: config,
          KOREKAITE_COVERAGE_SUITE: 'node',
        },
      });
    },
  };
}

test('CommonJSの対象をrequireして元ソースの関数呼出しを保存する', () => {
  const item = fixture('choose.cjs', 'module.exports = function choose() { return 7; };');
  const child = item.execute("if (require('./choose.cjs')() !== 7) process.exit(1)");
  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
  expect(readCaptures(item.directory)[0].files[0].coverage.f['0']).toBe(1);
});

test('台帳作成後に元ソースが変更された場合は実行を拒否する', () => {
  const item = fixture('value.mjs', 'export const value = 1;');
  writeFileSync(join(item.root, 'value.mjs'), 'export const value = 2;');
  const child = item.execute("import('./value.mjs')");
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('計測対象が変更されています: value.mjs');
});

test('終了前にカウンターが失われても空の収集記録を残す', () => {
  const item = fixture('value.mjs', 'export const value = 1;');
  const child = item.execute('delete globalThis.__coverage__');
  expect(child.status).toBe(0);
  expect(readCaptures(item.directory)[0]).toMatchObject({ status: 'complete', files: [] });
});
