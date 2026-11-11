import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { readCaptures } from '../src/capture.ts';
import { instrumentSource } from '../src/instrument.ts';

const loader = fileURLToPath(new URL('../src/node-loader.ts', import.meta.url));

test.each([0, 1])('Node子プロセスの終了コード%dでも収集の完了を保存する', (exitCode) => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-node-'));
  try {
    const path = 'choose.mjs';
    const source = 'export function choose(value) { if(value) return 1; return 2; }';
    const result = instrumentSource(path, source);
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const run = {
      runId: 'node-run',
      revision: 'revision',
      requiredSuites: ['node'],
      targets: [
        {
          path,
          sourceHash: hash(source),
          instrumentationHash: hash(result.code),
          coverage: result.coverage,
        },
      ],
    };
    writeFileSync(join(root, path), source);
    const directory = join(root, 'captures');
    mkdirSync(directory);
    const config = join(root, 'run.json');
    writeFileSync(config, JSON.stringify({ root, directory, run }));
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        loader,
        '--input-type=module',
        '-e',
        `import { choose } from ${JSON.stringify(pathToFileURL(join(root, path)).href)}; if(choose(true)!==1) throw new Error("unexpected result"); process.exit(${exitCode});`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, KOREKAITE_COVERAGE_RUN: config, KOREKAITE_COVERAGE_SUITE: 'node' },
      },
    );
    expect(child.stderr).toBe('');
    expect(child.status).toBe(exitCode);
    const files = readdirSync(directory).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(directory, files[0]), 'utf8'));
    expect(record).toMatchObject({ status: 'complete', suite: 'node', runId: 'node-run' });
    expect(record.files[0].coverage.statementMap).toEqual(result.coverage.statementMap);
    expect(record.files[0].coverage.f['0']).toBe(1);
    expect(record.files[0].coverage.b['0']).toEqual([1, 0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SIGKILLされたNode子プロセスも同期journalから実行回数を回収する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-node-kill-'));
  const childState = { child: undefined as ReturnType<typeof spawn> | undefined };
  try {
    const path = 'choose.mjs';
    const source = 'export function choose(value) { if(value) return 1; return 2; }';
    const result = instrumentSource(path, source);
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const run = {
      runId: 'kill-run',
      revision: 'revision',
      requiredSuites: ['node'],
      targets: [
        {
          path,
          sourceHash: hash(source),
          instrumentationHash: hash(result.code),
          coverage: result.coverage,
        },
      ],
    };
    const directory = join(root, 'captures');
    writeFileSync(join(root, path), source);
    const config = join(root, 'run.json');
    writeFileSync(config, JSON.stringify({ root, directory, run }));
    childState.child = spawn(
      process.execPath,
      [
        '--import',
        loader,
        '--input-type=module',
        '-e',
        `import { choose } from ${JSON.stringify(pathToFileURL(join(root, path)).href)}; import { writeSync } from 'node:fs'; choose(true); writeSync(1, 'ready'); setInterval(() => {}, 1000);`,
      ],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          KOREKAITE_COVERAGE_RUN: config,
          KOREKAITE_COVERAGE_SUITE: 'node',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await new Promise<void>((resolve, reject) => {
      childState.child!.stdout!.once('data', () => resolve());
      childState.child!.once('error', reject);
      childState.child!.once('exit', () => reject(new Error('準備前に終了しました')));
    });
    const closed = new Promise((resolve) => childState.child!.once('close', resolve));
    childState.child.kill('SIGKILL');
    await closed;
    const records = readCaptures(directory);
    expect(records[0].status).toBe('complete');
    expect(records[0].files[0].coverage.f['0']).toBe(1);
    expect(records[0].files[0].coverage.b['0']).toEqual([1, 0]);
  } finally {
    childState.child?.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
