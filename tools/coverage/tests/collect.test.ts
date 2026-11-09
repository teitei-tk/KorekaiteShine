import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, onTestFinished, test, vi } from 'vitest';
import { collectCoverage } from '../src/collect.ts';

test('失敗したsuiteの収集片を成功レポートとして集計しない', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-failed-suite-'));
  try {
    writeFileSync(join(root, 'unused.ts'), 'export const value = 1;');
    await expect(
      collectCoverage({
        root,
        paths: ['unused.ts'],
        revision: 'revision',
        commands: [{ suite: 'failed', command: process.execPath, args: ['-e', 'process.exit(1)'] }],
      }),
    ).rejects.toThrow('計測suiteが失敗しました: failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([undefined, ''])(
  'NODE_OPTIONS=%sでも台帳と収集片を作りNode実行を集計する',
  async (options) => {
    vi.stubEnv('NODE_OPTIONS', options);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const root = mkdtempSync(join(tmpdir(), 'coverage-run-'));
    try {
      writeFileSync(
        join(root, 'choose.mjs'),
        'export function choose(value) { if(value) return 1; return 2; }',
      );
      const result = await collectCoverage({
        root,
        paths: ['choose.mjs'],
        revision: 'revision',
        commands: [
          {
            suite: 'node',
            command: process.execPath,
            args: [
              '--input-type=module',
              '-e',
              `import { choose } from ${JSON.stringify(pathToFileURL(join(root, 'choose.mjs')).href)}; choose(true);`,
            ],
          },
        ],
      });
      expect(result.fileCoverageFor('choose.mjs').b['0']).toEqual([1, 0]);
      expect(
        JSON.parse(readFileSync(join(root, 'coverage/run.json'), 'utf8')).run.requiredSuites,
      ).toEqual(['inventory', 'node']);
      expect(readFileSync(join(root, 'coverage/combined/index.html'), 'utf8')).toContain(
        'choose.mjs',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
