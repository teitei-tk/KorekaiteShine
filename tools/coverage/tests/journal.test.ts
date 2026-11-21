import { parse } from '../src/schema.ts';
import { spawnSync } from 'node:child_process';
import { SystemError } from '../../testing/system-error.mts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { assert, expect, test, vi, onTestFinished } from 'vitest';
import {
  createCounterJournal,
  replayCounterJournal,
  counterJournalOwnerIsRunning,
} from '../src/journal.ts';
import { createMergeFixture } from './fixtures/measurement.ts';
import { instrumentSource } from '../src/instrument.ts';

test('1万回の同期更新をCLIの10秒予算内で保存して全回数を復元する', () => {
  const file = journalPath();
  const { run, path, target } = createMergeFixture();
  const script = `
import { createCounterJournal } from ${JSON.stringify(new URL('../src/journal.ts', import.meta.url).href)};
const data = createCounterJournal(${JSON.stringify(file)}, ${JSON.stringify(run.targets)});
const path = ${JSON.stringify(path)};
data[path] = ${JSON.stringify(target.coverage)};
for (let index = 0; index < 10000; index++) data[path].f['0']++;
`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 10_000,
  });
  expect(child.status, child.error?.message ?? child.stderr).toBe(0);
  expect(replayCounterJournal(file)[0].coverage.f['0']).toBe(10_000);
}, 20_000);

test('所有者への権限エラーを終了済みと誤判定しない', () => {
  const path = journalPath();
  writeFileSync(path, `${JSON.stringify({ type: 'start', pid: 12_345 })}\n`);
  const failure = new SystemError('permission', 'EPERM');
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw failure;
  });
  expect(() => counterJournalOwnerIsRunning(path)).toThrow(failure);
});
test('開始記録のPIDが不正ならjournal所有者を信用しない', () => {
  const path = journalPath();
  writeFileSync(path, `${JSON.stringify({ type: 'start', pid: 0 })}\n`);
  expect(() => counterJournalOwnerIsRunning(path)).toThrow('開始記録が不正');
});

function journalPath() {
  const directory = mkdtempSync(join(tmpdir(), 'journal-errors-'));
  onTestFinished(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  return join(directory, 'events.jsonl');
}

test('台帳にないファイルのカウンターをjournalへ混ぜない', () => {
  const { run, target } = createMergeFixture();
  const journal = createCounterJournal(journalPath(), run.targets);
  onTestFinished(() => {
    journal[Symbol.dispose]();
  });
  expect(() => {
    journal['unknown.ts'] = target.coverage;
  }).toThrow('台帳にない計測対象');
});

test('終了処理がなくても同期記録した文・関数・分岐の回数を復元できる', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-journal-'));
  try {
    const { run, target, path } = createMergeFixture();
    const source =
      (
        (target.coverage.inputSourceMap ?? assert.fail('必須のテスト値がありません。'))
          .sourcesContent ?? assert.fail('必須のテスト値がありません。')
      )[0] ?? assert.fail('必須のテスト値がありません。');
    const { code } = instrumentSource(path, source);
    const file = join(directory, 'events.jsonl');
    const data = createCounterJournal(file, run.targets);
    onTestFinished(() => {
      data[Symbol.dispose]();
    });
    runInNewContext(`${code}\nchoose(true); choose(false);`, { __coverage__: data });
    const recovered = replayCounterJournal(file);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].coverage).toEqual(parse(JSON.stringify(data[path])));
    expect(recovered[0].coverage.f['0']).toBe(2);
    expect(recovered[0].coverage.b['0']).toEqual([1, 1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('対象より先のcountを再生しない', () => {
  const path = journalPath();
  writeFileSync(
    path,
    JSON.stringify({ type: 'count', path: 'missing.ts', kind: 's', id: '0', index: 0, value: 1 }),
  );
  expect(() => replayCounterJournal(path)).toThrow('対象記録がありません');
});

test('moduleを開始ヘッダーとして信用しない', () => {
  const path = journalPath();
  const { target } = createMergeFixture();
  writeFileSync(path, JSON.stringify({ type: 'module', file: target }));
  expect(() => counterJournalOwnerIsRunning(path)).toThrow('開始記録が不正');
});

test('壊れたイベントと未知のイベントを拒否する', () => {
  const path = journalPath();
  for (const event of [
    null,
    { type: 'other' },
    { type: 'count', path: 'x', kind: 's', id: '0', index: 0, value: -1 },
  ]) {
    writeFileSync(path, JSON.stringify(event));
    expect(() => replayCounterJournal(path)).toThrow('計測journalが不正');
  }
});
