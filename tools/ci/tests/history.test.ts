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
