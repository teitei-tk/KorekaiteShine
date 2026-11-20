import { parse } from '../src/schema.ts';
import { verifySavedCoverage } from '../src/verify.ts';
import type { collectCoverage } from '../src/collect.ts';
import type * as LintTypeModule0 from 'node:fs';
import { writeSync } from 'node:fs';
import { createCoverageMap } from '@vitest/istanbul-lib-coverage';
import { expect, onTestFinished, test, vi } from 'vitest';
import { cli, main } from '../run.ts';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof LintTypeModule0>()),
  writeSync: vi.fn(),
}));
vi.mock('../src/shards.ts', () => ({ mergeSavedShards: vi.fn() }));
vi.mock('../src/verify.ts', () => ({ verifySavedCoverage: vi.fn() }));
const collect = vi.hoisted(() => vi.fn<typeof collectCoverage>());
vi.mock('../src/collect.ts', () => ({ collectCoverage: collect }));
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_command: string, args: string[]) =>
    args[0] === 'ls-files' ? 'src/example.ts\0' : 'revision\n',
  ),
}));

test('全体収集はAPI生成と保持確認の準備を済ませてから結合テストを実行する', async () => {
  collect.mockResolvedValue(createCoverageMap({}));
  await main([]);
  const [firstCall] = collect.mock.calls;
  const [options] = firstCall;
  const { commands } = options;
  expect(commands.map((command: { suite: string }) => command.suite)).toEqual([
    'generate',
    'api-codegen',
    'prepare',
    'web-build',
    'tests',
  ]);
  expect(commands[3]).toMatchObject({ command: 'pnpm', args: ['--dir', 'apps/web', 'build:app'] });
  expect(commands[2]).toMatchObject({ command: 'pnpm', args: ['prepare:integration'] });
});

test('CLIの正常終了で4指標の集計を標準出力へ書く', async () => {
  collect.mockResolvedValue(createCoverageMap({}));
  await cli([]);
  expect(vi.mocked(writeSync).mock.calls[0][0]).toBe(1);
  expect(parse(vi.mocked(writeSync).mock.calls[0][1])).toHaveProperty('branches');
});

test('Error以外の失敗も標準エラーへ記録して終了コードを失敗にする', async () => {
  const original = process.exitCode;
  onTestFinished(() => {
    process.exitCode = original;
  });
  collect.mockRejectedValue('失敗理由');
  await cli([]);
  expect(writeSync).toHaveBeenCalledWith(2, '失敗理由\n');
  expect(process.exitCode).toBe(1);
});

test('checkは再収集せず現在の対象とrevisionで保存結果を検査する', async () => {
  const expected = createCoverageMap({});
  vi.mocked(verifySavedCoverage).mockResolvedValue(expected);
  expect(await main(['--check'], '/fixture')).toBe(expected);
  expect(verifySavedCoverage).toHaveBeenCalledWith('/fixture', ['src/example.ts'], 'revision');
  expect(collect).not.toHaveBeenCalled();
});

test('分割計測は全準備を維持しVitestに4分割の番号を渡す', async () => {
  collect.mockResolvedValue(createCoverageMap({}));
  await main(['--shard=2/4']);
  const [call] = collect.mock.calls;
  expect(call[0].shard).toBe(2);
  expect(call[0].commands.at(-1)?.args).toContain('--shard=2/4');
});

test('分割統合は再収集せず保存された成果物を検証する', async () => {
  const { mergeSavedShards } = await import('../src/shards.ts');
  vi.mocked(mergeSavedShards).mockResolvedValue(createCoverageMap({}));
  await main(['--merge-shards'], '/fixture');
  expect(mergeSavedShards).toHaveBeenCalledWith('/fixture', ['src/example.ts'], 'revision');
  expect(collect).not.toHaveBeenCalled();
});

test.each(['--shard=0/4', '--shard=5/4', '--shard=1/3'])(
  '範囲外の分割指定%sを拒否する',
  async (argument) => {
    await expect(main([argument])).rejects.toThrow('使い方');
    expect(collect).not.toHaveBeenCalled();
  },
);
