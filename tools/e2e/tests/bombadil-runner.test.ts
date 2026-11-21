import { expect, test } from 'vitest';
import { parseExplorationOptions } from '../bombadil/options.ts';

test('探索対象に未知の値を指定した場合は起動前に拒否する', () => {
  expect(() => parseExplorationOptions(['--target', 'other'])).toThrow('探索対象');
});

test('探索時間は整数の60〜600秒に限定し、明示しなければ120秒にする', () => {
  expect(parseExplorationOptions([])).toEqual({ target: 'preparation', seconds: 120 });
  expect(parseExplorationOptions(['--target', 'history', '--seconds', '60'])).toEqual({
    target: 'history',
    seconds: 60,
  });
  expect(parseExplorationOptions(['--seconds', '600']).seconds).toBe(600);
  for (const seconds of ['59', '601', '60.5', 'NaN', '1e2', '']) {
    expect(() => parseExplorationOptions(['--seconds', seconds])).toThrow('探索時間');
  }
});

test('CLIは記録先と再現元を保持し、URL・未知の引数・重複指定・欠損値を拒否する', () => {
  expect(
    parseExplorationOptions([
      '--target',
      'history',
      '--output',
      'result',
      '--reproduce',
      'previous',
    ]),
  ).toEqual({
    target: 'history',
    seconds: 120,
    outputDirectory: 'result',
    reproduce: 'previous',
  });
  for (const args of [
    ['--url', 'https://example.com'],
    ['--live'],
    ['history'],
    ['--target', 'history', '--target', 'preparation'],
    ['--output'],
    ['--output', ''],
    ['--reproduce', ''],
  ]) {
    expect(() => parseExplorationOptions(args)).toThrow();
  }
});
