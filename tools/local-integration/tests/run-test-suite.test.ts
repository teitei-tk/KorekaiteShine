import { expect, test } from 'vitest';
import { runTestProcess } from '../src/run-test-suite.ts';

test('検査プロセスの失敗とsignal終了を成功へ変換しない', async () => {
  expect(await runTestProcess(['-e', 'process.exit(7)'], process.cwd())).toBe(7);
  expect(await runTestProcess(['-e', 'process.kill(process.pid, "SIGTERM")'], process.cwd())).toBe(
    143,
  );
  expect(await runTestProcess(['-e', 'process.exit(0)'], process.cwd())).toBe(0);
});

test('親の中断も子へ伝播し、終了結果を143にする', async () => {
  const moduleUrl = new URL('../src/run-test-suite.ts', import.meta.url).href;
  const program = `import { runTestProcess } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await runTestProcess(['-e', 'process.kill(process.ppid, "SIGTERM"); setInterval(() => {}, 1000)'], process.cwd());`;
  expect(await runTestProcess(['--input-type=module', '-e', program], process.cwd())).toBe(143);
});

test('Vitestが探索するspecとsrc配下も未登録検査に含める', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { discoverTestFiles } = await import('../src/run-test-suite.ts');
  const dir = await mkdtemp(join(tmpdir(), 'test-discovery-'));
  try {
    await mkdir(join(dir, 'tests'));
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'tests/new.spec.ts'), '');
    await writeFile(join(dir, 'src/new.test.ts'), '');
    expect((await discoverTestFiles(dir)).sort()).toEqual(['src/new.test.ts', 'tests/new.spec.ts']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function executeSuite(args: string[], mode = 'success') {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = mkdtempSync(join(tmpdir(), 'test-suite-cli-'));
  const bootstrap = join(root, 'bootstrap.mjs');
  const output = join(root, 'args.json');
  try {
    writeFileSync(
      bootstrap,
      `import cp from 'node:child_process'; import { EventEmitter } from 'node:events'; import { writeFileSync } from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
cp.spawn = (program,args) => {
 if(program !== process.execPath) throw new Error('unexpected program');
 writeFileSync(${JSON.stringify(output)}, JSON.stringify(args));
 const child = new EventEmitter(); child.exitCode = 0; child.signalCode = null;
 child.kill = signal => { child.emit('close', null, signal); return true; };
 queueMicrotask(() => {
  if (${JSON.stringify(mode)} === 'interrupt') process.emit('SIGINT');
  else if (${JSON.stringify(mode)} === 'error') child.emit('error', new Error('fixture spawn error'));
  else child.emit('close', ${mode === 'null' ? 'null' : '0'}, null);
 }); return child;
}; syncBuiltinESMExports();`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        bootstrap,
        fileURLToPath(new URL('../src/run-test-suite.ts', import.meta.url)),
        ...args,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    return {
      ...result,
      selected: existsSync(output) ? (JSON.parse(readFileSync(output, 'utf8')) as string[]) : [],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('検査CLIは指定した分割をlistコマンドへ渡す', async () => {
  const result = await executeSuite(['boundary', '1', '--list']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.selected[1]).toBe('list');
  expect(result.selected).toContain('tests/check-object.test.ts');
  expect(result.selected).not.toContain('tests/topology.test.ts');
});

test('検査CLIは分割なしと実行オプションをrunへ渡す', async () => {
  const result = await executeSuite(['boundary', '--maxWorkers=2']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.selected[1]).toBe('run');
  expect(result.selected).toContain('tests/check-object.test.ts');
  expect(result.selected).toContain('tests/topology.test.ts');
  expect(result.selected).toContain('--maxWorkers=2');
});

test('検査CLIはsuite欠落で失敗し検査プロセスを起動しない', async () => {
  const result = await executeSuite([]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('検査の種類が不明');
  expect(result.selected).toEqual([]);
});

test('起動失敗と終了理由の欠落を正常終了へ変換しない', async () => {
  for (const mode of ['error', 'null']) {
    const result = await executeSuite(['boundary'], mode);
    expect(result.status).toBe(1);
    if (mode === 'error') {
      expect(result.stderr).toContain('fixture spawn error');
    }
  }
});

test('検査CLIへのSIGINTを子へ伝え130で終了する', async () => {
  const result = await executeSuite(['boundary'], 'interrupt');
  expect(result.status, result.stderr).toBe(130);
});
