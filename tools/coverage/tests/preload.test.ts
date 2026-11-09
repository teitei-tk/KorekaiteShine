import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { prepareRun } from '../src/prepare.ts';
import { readCaptures } from '../src/capture.ts';
import { createNodePreload } from '../src/preload.ts';

test('Node起動時のローダー自身の実行を原本のカウンターへ記録する', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'coverage-preload-'));
  try {
    const path = 'tools/coverage/src/node-loader.ts';
    const { run } = prepareRun(root, [path], 'revision', ['node']);
    const config = join(directory, 'run.json');
    writeFileSync(config, JSON.stringify({ root, directory: join(directory, 'records'), run }));
    const preload = createNodePreload(root, run, directory);
    const child = spawnSync(process.execPath, ['--import', preload, '-e', '0'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        KOREKAITE_COVERAGE_RUN: config,
        KOREKAITE_COVERAGE_SUITE: 'node',
      },
    });
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const files = readCaptures(join(directory, 'records')).flatMap((record) => record.files);
    const loader = files.find((file) => file.path === path);
    expect(loader).toBeDefined();
    expect(Object.values(loader!.coverage.s).some((count) => count > 0)).toBe(true);
    expect(Object.values(loader!.coverage.f).some((count) => count > 0)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
