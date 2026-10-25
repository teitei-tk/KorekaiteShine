import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
it('型のunknownを拒否し、コメント・文字列中のunknownは許可する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-policy-'));
  try {
    const file = join(dir, 'sample.ts');
    const lint = (source: string) => {
      writeFileSync(file, source);
      return spawnSync(
        join(root, 'node_modules/.bin/oxlint'),
        ['--config', join(root, '.oxlintrc.json'), '--no-ignore', file],
        { cwd: root, encoding: 'utf8' },
      );
    };
    for (const source of [
      'export type Input = unknown;',
      'export type Input = { value: unknown };',
      'export type Input = Array<unknown>;',
    ]) {
      const result = lint(source);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('no-restricted-types');
    }
    expect(lint('// unknownを説明するコメント\nexport const label = "unknown";').status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
