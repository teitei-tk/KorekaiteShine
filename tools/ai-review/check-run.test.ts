import { expect, it } from 'vitest';
import { checkRun, runSnapshot } from './check-run.ts';
const raw = (status = 'in_progress', conclusion = '') =>
  JSON.stringify({
    status,
    conclusion,
    jobs: [
      {
        name: 'generate',
        status,
        conclusion,
        steps: [{ name: 'Review using GPT-6 Luna', status, conclusion }],
      },
    ],
  });
it('状態変化だけ表示し成功時に監視を終える', async () => {
  const values = [raw(), raw(), raw('completed', 'success')];
  const output: string[] = [];
  let waits = 0;
  expect(
    await checkRun(
      '123',
      true,
      () => values.shift()!,
      (s) => output.push(s),
      async () => {
        waits++;
      },
    ),
  ).toBe(0);
  expect(output).toHaveLength(3);
  expect(waits).toBe(2);
});
it('失敗箇所は固定ラベルで示し未知の名前・外部エラーを表示しない', async () => {
  const response = {
    status: 'completed',
    conclusion: 'failure',
    jobs: [
      {
        name: 'SECRET\n::warning::injection',
        status: 'completed',
        conclusion: 'failure',
        steps: [{ name: 'SECRET', status: 'completed', conclusion: 'failure' }],
      },
    ],
    error: 'SECRET',
  };
  const output: string[] = [];
  expect(
    await checkRun(
      '123',
      false,
      () => JSON.stringify(response),
      (s) => output.push(s),
    ),
  ).toBe(1);
  expect(output.join('\n')).toContain('step 1');
  expect(output.join('\n')).not.toContain('SECRET');
  await checkRun(
    '123',
    false,
    () => {
      throw new Error('SECRET stderr');
    },
    (s) => output.push(s),
  );
  expect(output.join('\n')).not.toContain('SECRET');
});
it('不正な状態・応答・IDを拒否する', async () => {
  for (const value of ['not json', '{}', raw('SECRET')]) expect(() => runSnapshot(value)).toThrow();
  let called = false;
  const output: string[] = [];
  expect(
    await checkRun(
      '123;SECRET',
      false,
      () => {
        called = true;
        return raw();
      },
      (s) => output.push(s),
    ),
  ).toBe(2);
  expect(called).toBe(false);
  expect(output.join('\n')).not.toContain('SECRET');
});
it('監視上限で停止し、単発確認は待たない', async () => {
  let reads = 0,
    waits = 0;
  const output: string[] = [];
  expect(
    await checkRun(
      '123',
      true,
      () => {
        reads++;
        return raw();
      },
      (s) => output.push(s),
      async () => {
        waits++;
      },
    ),
  ).toBe(2);
  expect(reads).toBe(40);
  expect(waits).toBe(39);
  expect(output).toHaveLength(3);
  expect(
    await checkRun(
      '123',
      false,
      () => raw(),
      () => {},
      async () => {
        throw new Error('wait');
      },
    ),
  ).toBe(0);
});

it('CLIでghのstderrを表示せず、失敗を終了コードで返す', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, delimiter } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'check-run-cli-'));
  try {
    writeFileSync(join(directory, 'gh'), '#!/bin/sh\necho SECRET >&2\nexit 1\n', { mode: 0o700 });
    const result = spawnSync(
      process.execPath,
      [new URL('./check-run.ts', import.meta.url).pathname, '123'],
      { encoding: 'utf8', env: { ...process.env, PATH: directory + delimiter + process.env.PATH } },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('SECRET');
    expect(result.stdout).toContain('取得・解析できませんでした');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('期待コミットを含まない実行では成功の状態確認へ進まず終了コード3にする', async () => {
  const { checkRunCommand } = await import('./check-run.ts');
  let checked = false;
  const output: string[] = [];
  expect(
    await checkRunCommand(
      ['123', '--watch', '--expect-commit', 'a'.repeat(40)],
      () => ({ output: '修正版の検証対象外', eligible: false }),
      async () => {
        checked = true;
        return 0;
      },
      (s) => output.push(s),
    ),
  ).toBe(3);
  expect(checked).toBe(false);
  expect(output).toContain('修正版の検証対象外');
});
it('実行版の取得失敗を成功扱いせず、外部エラーを出力しない', async () => {
  const { checkRunCommand } = await import('./check-run.ts');
  const output: string[] = [];
  expect(
    await checkRunCommand(
      ['123'],
      () => {
        throw new Error('SECRET');
      },
      async () => 0,
      (s) => output.push(s),
    ),
  ).toBe(2);
  expect(output.join('\n')).not.toContain('SECRET');
});
it('CLIは期待SHAと監視指定の順序を許容し、不正・重複オプションを拒否する', async () => {
  const { parseRunArgs } = await import('./check-run.ts');
  expect(parseRunArgs(['123', '--expect-commit', 'a'.repeat(40), '--watch'])).toEqual({
    id: '123',
    watch: true,
    expected: 'a'.repeat(40),
  });
  for (const options of [
    ['--expect-commit'],
    ['--expect-commit', 'abc'],
    ['--watch', '--watch'],
    ['--SECRET'],
  ])
    expect(() => parseRunArgs(['123', ...options])).toThrow();
});
