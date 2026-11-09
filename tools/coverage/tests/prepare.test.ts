import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { prepareRun } from '../src/prepare.ts';

test('未importも含む台帳を原本から作り生成物を計測しない', () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-prepare-'));
  try {
    writeFileSync(join(root, 'unused.ts'), 'export function unused() { return 1; }');
    const result = prepareRun(root, ['unused.ts', 'generated/api.ts', 'types.d.ts'], 'revision', [
      'unit',
    ]);
    expect(result.run.requiredSuites).toEqual(['unit']);
    expect(result.run.targets.map((target) => target.path)).toEqual(['unused.ts']);
    expect(result.run.targets[0].coverage.f).toEqual({ '0': 0 });
    expect(result.run.targets[0].sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.entries).toHaveLength(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
