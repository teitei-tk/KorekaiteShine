import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const command = fileURLToPath(new URL('../src/run.ts', import.meta.url));

test('ローカル操作入口はremoteオプションを起動前に拒否する', () => {
  const result = spawnSync(process.execPath, [command, 'db:migrate', '--remote'], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('追加引数は受け付けません');
});
