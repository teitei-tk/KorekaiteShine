import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import { prepareRun } from '../src/prepare.ts';
import { instrumentSource } from '../src/instrument.ts';
import { readMeasurement } from '../src/schema.ts';

test('台帳の検証もメモリで計測し、終了時に保存して子プロセス用journalを復元する', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-setup-memory-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const path = 'tools/coverage/src/schema.ts';
  const schemaUrl = new URL('../src/schema.ts', import.meta.url);
  const { run } = prepareRun(root, [path], 'revision', ['unit']);
  const config = join(directory, 'run.json');
  const captures = join(directory, 'captures');
  writeFileSync(config, JSON.stringify({ root, directory: captures, run }));
  const { code } = instrumentSource(path, readFileSync(schemaUrl, 'utf8'));
  const script = `
import { registerHooks } from 'node:module';
let journalWrites = 0;
const wrap = value => new Proxy(value, { set(target, key, count) {
  journalWrites++; return Reflect.set(target, key, count);
} });
const inherited = new Proxy({}, { set(target, key, value) {
  value.s = wrap(value.s); value.f = wrap(value.f);
  for (const id of Object.keys(value.b)) value.b[id] = wrap(value.b[id]);
  return Reflect.set(target, key, value);
} });
globalThis.__coverage__ = inherited;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'vitest'
      ? { url: 'data:text/javascript,export const afterAll = cb => { globalThis.finishFixture = cb; };', shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    return url === ${JSON.stringify(schemaUrl.href)}
      ? { format: 'module', source: ${JSON.stringify(code)}, shortCircuit: true }
      : next(url, context);
  },
});
await import(${JSON.stringify(new URL('../src/vitest-setup.ts', import.meta.url).href)});
globalThis.finishFixture();
console.log(JSON.stringify({ journalWrites, restored: globalThis.__coverage__ === inherited }));
`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      KOREKAITE_COVERAGE_RUN: config,
      KOREKAITE_COVERAGE_SUITE: 'unit',
    },
  });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ journalWrites: 0, restored: true });
  const records = readdirSync(captures)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readMeasurement(readFileSync(join(captures, name), 'utf8')));
  expect(records).toHaveLength(1);
  expect(records[0].status).toBe('complete');
  expect(records[0].files[0].path).toBe(path);
  expect(Object.values(records[0].files[0].coverage.f).some((count) => count > 0)).toBe(true);
});

test('終了フックはカウンターがない場合も空の完了記録を保存する', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-setup-boundary-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
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
const inherited = globalThis.__coverage__ ?? {};
globalThis.__coverage__ = inherited;
await import(${JSON.stringify(new URL('../src/vitest-setup.ts', import.meta.url).href)});
if (globalThis.__coverage__ === inherited) throw new Error('Vitest collection reused the Node child journal');
crypto.randomUUID = originalUUID;
syncBuiltinESMExports();
const { directory } = JSON.parse(readFileSync(process.env.KOREKAITE_COVERAGE_RUN, 'utf8'));
const id = ${JSON.stringify(captureId)};
delete globalThis.__coverage__;
globalThis.finishFixture();
if (globalThis.__coverage__ !== inherited) throw new Error('Node child journal not restored');
const record = JSON.parse(readFileSync(join(directory, id + '.json'), 'utf8'));
if (record.status !== 'complete' || record.files.length !== 0) throw new Error('empty capture was not saved');
`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      KOREKAITE_COVERAGE_RUN: process.env.KOREKAITE_COVERAGE_RUN ?? config,
      KOREKAITE_COVERAGE_SUITE: process.env.KOREKAITE_COVERAGE_SUITE ?? 'unit',
    },
  });
  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
});
