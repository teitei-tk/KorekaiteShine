import { parseArgs } from 'node:util';
import type { ExplorationOptions } from './types.ts';

export function parseExplorationOptions(args: readonly string[]): ExplorationOptions {
  const { values, tokens } = parseArgs({
    args: [...args],
    options: {
      target: { type: 'string' },
      seconds: { type: 'string' },
      output: { type: 'string' },
      reproduce: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind === 'option') {
      if (
        seen.has(token.name) ||
        ((token.name === 'output' || token.name === 'reproduce') && !token.value)
      ) {
        throw new Error('オプションの重複指定や空の値は使用できません。');
      }
      seen.add(token.name);
    }
  }
  const target = values.target ?? 'preparation';
  if (target !== 'preparation' && target !== 'history') {
    throw new Error('探索対象は preparation または history を指定してください。');
  }
  const rawSeconds = values.seconds ?? '120';
  const seconds = Number(rawSeconds);
  if (!/^\d+$/u.test(rawSeconds) || !Number.isInteger(seconds) || seconds < 60 || seconds > 600) {
    throw new Error('探索時間は60〜600秒の整数を指定してください。');
  }
  return {
    target,
    seconds,
    ...(values.output ? { outputDirectory: values.output } : {}),
    ...(values.reproduce ? { reproduce: values.reproduce } : {}),
  };
}
