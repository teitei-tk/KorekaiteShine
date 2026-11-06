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
