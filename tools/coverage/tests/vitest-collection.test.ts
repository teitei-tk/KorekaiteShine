import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { prepareRun } from '../src/prepare.ts';

const require = createRequire(import.meta.url);

test.each([true, false])(
  'Vitestの実プロセスで対象の読込有無%sに応じた計測片を保存する',
  (loaded) => {
    const root = mkdtempSync(join(tmpdir(), 'coverage-vitest-'));
    try {
      writeFileSync(
        join(root, 'choose.ts'),
        'export function choose(value: boolean) { if(value) return 1; return 2; }',
      );
      const { run } = prepareRun(root, ['choose.ts'], 'revision', ['unit']);
      const directory = join(root, 'captures');
      const config = join(root, 'run.json');
      writeFileSync(config, JSON.stringify({ root, directory, run }));
      writeFileSync(
        join(root, 'choose.test.mjs'),
        loaded
          ? `import { test, expect } from ${JSON.stringify(join(dirname(require.resolve('vitest/package.json')), 'dist/index.js'))}; import { choose } from './choose.ts'; test('choose', () => expect(choose(false)).toBe(2));`
          : `import { test, expect } from ${JSON.stringify(join(dirname(require.resolve('vitest/package.json')), 'dist/index.js'))}; test('empty', () => expect(1).toBe(1));`,
      );
      const factory = fileURLToPath(new URL('../src/vitest-config.ts', import.meta.url));
      writeFileSync(
        join(root, 'vitest.config.mjs'),
        `import { vitestCoverageConfig } from ${JSON.stringify(factory)}; export default vitestCoverageConfig(${JSON.stringify(config)}, ['.']);`,
      );
      const outputPath = join(root, 'vitest.log');
      const output = openSync(outputPath, 'w');
      const child = spawnSync(
        process.execPath,
        [
          join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
          'run',
          '--config',
          join(root, 'vitest.config.mjs'),
        ],
        {
          cwd: root,
          stdio: ['ignore', output, output],
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            KOREKAITE_COVERAGE_RUN: config,
            KOREKAITE_COVERAGE_SUITE: 'unit',
          },
          timeout: 30000,
        },
      );
      closeSync(output);
      expect(child.status, readFileSync(outputPath, 'utf8')).toBe(0);
      const records = readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe('complete');
      if (loaded) {
        expect(records[0].files[0].coverage.b['0']).toEqual([0, 1]);
      } else {
        expect(records[0].files).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
