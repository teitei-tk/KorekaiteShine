import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';

test('終了フックはカウンターがない場合も空の完了記録を保存する', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-setup-boundary-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'run.json');
  writeFileSync(
    config,
    JSON.stringify({
      directory,
      run: { runId: 'empty', revision: 'revision', requiredSuites: ['unit'], targets: [] },
    }),
  );
  const captureId = randomUUID();
  const script = `
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
registerHooks({ resolve(specifier, context, next) {
  return specifier === 'vitest' ? { url: 'data:text/javascript,export const afterAll = callback => { globalThis.finishFixture = callback; };', shortCircuit: true } : next(specifier, context);
}});
const originalUUID = crypto.randomUUID;
crypto.randomUUID = () => ${JSON.stringify(captureId)};
syncBuiltinESMExports();
await import(${JSON.stringify(new URL('../src/vitest-setup.ts', import.meta.url).href)});
crypto.randomUUID = originalUUID;
syncBuiltinESMExports();
const { directory } = JSON.parse(readFileSync(process.env.KOREKAITE_COVERAGE_RUN, 'utf8'));
const id = ${JSON.stringify(captureId)};
const saved = globalThis.__coverage__;
delete globalThis.__coverage__;
globalThis.finishFixture();
globalThis.__coverage__ = saved;
const record = JSON.parse(readFileSync(join(directory, id + '.json'), 'utf8'));
if (record.status !== 'complete' || record.files.length !== 0) throw new Error('empty capture was not saved');
`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      KOREKAITE_COVERAGE_RUN: process.env.KOREKAITE_COVERAGE_RUN ?? config,
      KOREKAITE_COVERAGE_SUITE: process.env.KOREKAITE_COVERAGE_SUITE ?? 'unit',
    },
  });
  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
});
