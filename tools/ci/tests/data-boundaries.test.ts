import { expect, test } from 'vitest';
import { parseJson, isJsonValue } from '../src/json.ts';
import { assignTests } from '../src/plan.ts';
import { isPlan, parsePlan } from '../src/schema.ts';
import { validateResults } from '../src/results.ts';
import { readHistory, mergeHistory } from '../src/history.ts';

test('JSONの数値範囲と非JSON値を拒否する', () => {
  expect(() => parseJson('1e400')).toThrow('JSON値が不正');
  expect(isJsonValue({ nested: [undefined] })).toBe(false);
});
test('割当数とテストIDの重複を検証する', () => {
  for (const count of [0, -1, 1.5, Number.NaN]) {
    expect(() => assignTests(['a'], {}, count)).toThrow('割当入力');
  }
  expect(() => assignTests(['a', 'a'], {}, 1)).toThrow('割当入力');
});
test('計画のnullable文字列とaffectedモードを受理し不正な結果を拒否する', () => {
  const plan = {
    schema: 1,
    sha: 'a',
    baseSha: 'b',
    headSha: 'a',
    mode: 'affected',
    graphVersion: 1,
    historyId: 'h',
    inventoryHash: 'i',
    reasons: ['change'],
    tests: [],
    selected: [],
    shards: [],
    repository: 'r',
    workflow: 'CI',
  };
  expect(parsePlan(JSON.stringify(plan))).toStrictEqual(plan);
  expect(isPlan({ ...plan, baseSha: 1 })).toBe(false);
  for (const results of [null, [{}]]) {
    expect(() => validateResults(plan, results)).toThrow('計画・結果');
  }
  expect(() => validateResults(null, [])).toThrow('計画・結果');
});
test('サンプル時刻の破損と未来を除外し空の更新も扱う', () => {
  const current = {
    schema: 1,
    id: 'new',
    repository: 'r',
    workflow: 'CI',
    event: 'push',
    branch: 'main',
    conclusion: 'success',
    createdAt: '2026-11-19T00:00:00Z',
    samples: [],
  } as const;
  const context = {
    repository: 'r',
    workflow: 'CI',
    now: Temporal.Instant.from(current.createdAt).epochMilliseconds,
  };
  const previous = {
    ...current,
    samples: [
      { id: 'bad', identity: 'node', durationMs: 1, sampledAt: 'bad' },
      { id: 'future', identity: 'node', durationMs: 1, sampledAt: '2026-11-20T00:00:00Z' },
      { id: 'valid', identity: 'node', durationMs: 2 },
    ],
  };
  expect(readHistory(previous, context, 'node').durations).toStrictEqual({ valid: 2 });
  expect(mergeHistory(previous, { ...current, samples: [] }).samples).toStrictEqual([
    { id: 'valid', identity: 'node', durationMs: 2, sampledAt: current.createdAt },
  ]);
  expect(mergeHistory(null, { ...current, samples: [] }).samples).toStrictEqual([]);
});
