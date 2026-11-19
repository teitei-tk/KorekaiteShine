import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { instrumentSource } from '../src/instrument.ts';
import { coveragePlugin } from '../src/vite-plugin.ts';
import { createMergeFixture } from './fixtures/measurement.ts';
vi.mock('../src/instrument.ts', { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
});

test('変換器がnullのsourceを返したら元ソースへの対応を捏造しない', () => {
  const { run, path } = createMergeFixture();
  const source = 'function choose(value: boolean) { if (value) return 1; return 2; }';
  const result = instrumentSource(path, source);
  run.targets[0].sourceHash = createHash('sha256').update(source).digest('hex');
  run.targets[0].instrumentationHash = createHash('sha256').update(result.code).digest('hex');
  vi.mocked(instrumentSource).mockReturnValue({
    ...result,
    map: { ...result.map, sources: [null] },
  });
  expect(() => coveragePlugin('/repo', run).transform(source, `/repo/${path}`)).toThrow(
    'source map source',
  );
});
