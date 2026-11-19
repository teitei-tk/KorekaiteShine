import { expect, test } from 'vitest';
import { readHistory } from '../src/history.ts';

test('履歴の出所、鮮度、実行クラスを検証し破損時は等重みへ戻す', () => {
  const context = {
    repository: 'org/repo',
    workflow: 'CI',
    now: Temporal.Now.instant().epochMilliseconds,
  };
  const history = {
    schema: 1,
    id: 'run1',
    repository: 'org/repo',
    workflow: 'CI',
    event: 'push',
    branch: 'main',
    conclusion: 'success',
    createdAt: Temporal.Instant.fromEpochMilliseconds(context.now).toString(),
    samples: [{ id: 'test', identity: 'node:linux:node26:workers2', durationMs: 40 }],
  };
  expect(readHistory(history, context, 'node:linux:node26:workers2').durations).toStrictEqual({
    test: 40,
  });
  for (const change of [
    { repository: 'evil/repo' },
    { createdAt: '2000-01-01' },
    { samples: [{ id: 'test', identity: 'node:linux:node26:workers2', durationMs: -1 }] },
    { event: 'pull_request' },
  ]) {
    expect(
      readHistory({ ...history, ...change }, context, 'node:linux:node26:workers2').durations,
    ).toStrictEqual({});
  }
  expect(readHistory(null, context, 'node:linux:node26:workers2').durations).toStrictEqual({});
});

test('更新は同一runnerの直近10成功を継承し古いサンプルを捨てる', async () => {
  const { mergeHistory } = await import('../src/history.ts');
  const createdAt = '2026-11-17T00:00:00Z';
  const current = {
    schema: 1,
    id: 'new',
    repository: 'org/repo',
    workflow: 'CI',
    event: 'push',
    branch: 'main',
    conclusion: 'success',
    createdAt,
    samples: [{ id: 'test', identity: 'node:linux:node26:workers2', durationMs: 100 }],
  } as const;
  const previous = {
    ...current,
    id: 'old',
    samples: Array.from({ length: 12 }, (_, i) => ({
      id: 'test',
      identity: 'node:linux:node26:workers2',
      durationMs: i + 1,
      sampledAt: i === 0 ? '2000-01-01T00:00:00Z' : createdAt,
    })),
  };
  const merged = mergeHistory(previous, { ...current, samples: [...current.samples] });
  expect(merged.samples).toHaveLength(10);
  expect(
    readHistory(
      merged,
      {
        repository: 'org/repo',
        workflow: 'CI',
        now: Temporal.Instant.from(createdAt).epochMilliseconds,
      },
      'node:linux:node26:workers2',
    ).durations.test,
  ).toBe(8.5);
});

test('main実測を優先し未計測IDだけ確認済み初期値で補う', async () => {
  const { readWeights } = await import('../src/history.ts');
  const context = {
    repository: 'org/repo',
    workflow: 'CI',
    now: Temporal.Instant.from('2026-11-19T00:00:00Z').epochMilliseconds,
  };
  const identity = 'boundary:linux:node26:workers2';
  const seed = {
    schema: 1,
    id: 'reviewed-run:123:1',
    repository: 'org/repo',
    workflow: 'CI',
    createdAt: '2026-11-18T00:00:00Z',
    source: { runId: 123, attempt: 1, headSha: 'a'.repeat(40), conclusion: 'success' },
    samples: [
      { id: 'slow', identity, durationMs: 240 },
      { id: 'fast', identity, durationMs: 10 },
    ],
  };
  const main = {
    ...seed,
    id: 'main-run',
    event: 'push',
    branch: 'main',
    samples: [{ id: 'fast', identity, durationMs: 20 }],
    conclusion: 'success',
  };
  expect(readWeights(main, seed, context, identity).durations).toStrictEqual({
    slow: 240,
    fast: 20,
  });
  expect(
    readWeights(
      {
        ...main,
        samples: [{ id: 'fast', identity, durationMs: 20, sampledAt: '2000-01-01T00:00:00Z' }],
      },
      seed,
      context,
      identity,
    ).durations,
  ).toStrictEqual({ slow: 240, fast: 10 });
  expect(readWeights(null, seed, context, identity).durations).toStrictEqual({
    slow: 240,
    fast: 10,
  });
  for (const change of [
    { repository: 'other/repo' },
    { workflow: 'other' },
    { createdAt: '2000-01-01' },
    { createdAt: '2099-01-01' },
    { source: { ...seed.source, conclusion: 'failure' } },
    { samples: [{ id: 'slow', identity, durationMs: -1 }] },
  ]) {
    expect(readWeights(null, { ...seed, ...change }, context, identity).durations).toStrictEqual(
      {},
    );
  }
  expect(readWeights(null, seed, context, 'worker:linux:node26:workers2').durations).toStrictEqual(
    {},
  );
  expect(readWeights(null, null, context, identity).durations).toStrictEqual({});
});

test('確認済み254件の初期実測値を使っても全対象を一度だけ配分する', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parseJson } = await import('../src/json.ts');
  const { readWeights } = await import('../src/history.ts');
  const { assignTests } = await import('../src/plan.ts');
  const seed = parseJson(await readFile(new URL('../timing-seed.json', import.meta.url), 'utf8'));
  const context = {
    repository: 'teitei-tk/KorekaiteShine',
    workflow: 'CI',
    now: Temporal.Instant.from('2026-11-19T12:00:00Z').epochMilliseconds,
  };
  const weights = readWeights(null, seed, context, 'boundary:linux:node26:workers2');
  const ids = Object.keys(weights.durations);
  expect(ids).toHaveLength(46);
  const bins = assignTests(ids, weights.durations, 4);
  expect(bins.flat().toSorted()).toStrictEqual(ids.toSorted());
  const totals = bins.map((bin) => bin.reduce((sum, id) => sum + weights.durations[id], 0));
  expect(Math.max(...totals) / Math.min(...totals)).toBeLessThan(1.05);
  expect(weights.sources).toStrictEqual(['reviewed-run:44509486336:1']);
});
