import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { collectCoverage } from '../src/collect.ts';
import { verifySavedCoverage } from '../src/verify.ts';

test('現在のソースと一致する全網羅結果を再検証して返す', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-verify-complete-'));
  try {
    writeFileSync(join(root, 'value.mjs'), 'export const value = 1;');
    await collectCoverage({
      root,
      paths: ['value.mjs'],
      revision: 'revision',
      commands: [
        {
          suite: 'node',
          command: process.execPath,
          args: [
            '--input-type=module',
            '-e',
            `await import(${JSON.stringify(pathToFileURL(join(root, 'value.mjs')).href)});`,
          ],
        },
      ],
    });
    const map = await verifySavedCoverage(root, ['value.mjs'], 'revision');
    expect(map.getCoverageSummary().statements.pct).toBe(100);
    expect(map.files()).toEqual(['value.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('保存済みの結果を現在のソースと照合してから閾値を検査する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-verify-'));
  try {
    writeFileSync(join(root, 'unused.ts'), 'export const value = 1;');
    await collectCoverage({ root, paths: ['unused.ts'], revision: 'revision', commands: [] });
    await expect(verifySavedCoverage(root, ['unused.ts'], 'revision')).rejects.toThrow(
      'カバレッジ不足',
    );
    writeFileSync(join(root, 'unused.ts'), 'export const value = 2;');
    await expect(verifySavedCoverage(root, ['unused.ts'], 'revision')).rejects.toThrow(
      '台帳が現在のソースと一致しません',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
