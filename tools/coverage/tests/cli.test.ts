import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('未知の引数では計測を開始せず失敗する', () => {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../run.ts', import.meta.url)), '--unknown'],
    { encoding: 'utf8' },
  );
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('使い方: node tools/coverage/run.ts [--check]');
});
