import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, test, vi, onTestFinished } from 'vitest';
import {
  createCounterJournal,
  replayCounterJournal,
  counterJournalOwnerIsRunning,
} from '../src/journal.ts';
import { createMergeFixture } from './fixtures/measurement.ts';
import { instrumentSource } from '../src/instrument.ts';
test('所有者への権限エラーを終了済みと誤判定しない', () => {
  const path = journalPath();
  writeFileSync(path, JSON.stringify({ type: 'start', pid: 12345 }) + '\n');
  const failure = Object.assign(new Error('permission'), { code: 'EPERM' });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw failure;
  });
  expect(() => counterJournalOwnerIsRunning(path)).toThrow(failure);
});
test('開始記録のPIDが不正ならjournal所有者を信用しない', () => {
  const path = journalPath();
  writeFileSync(path, JSON.stringify({ type: 'start', pid: 0 }) + '\n');
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
  expect(() => {
    journal['unknown.ts'] = target.coverage;
  }).toThrow('台帳にない計測対象');
});

test('終了処理がなくても同期記録した文・関数・分岐の回数を復元できる', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-journal-'));
  try {
    const { run, target, path } = createMergeFixture();
    const source = target.coverage.inputSourceMap!.sourcesContent![0]!;
    const { code } = instrumentSource(path, source);
    const file = join(directory, 'events.jsonl');
    const data = createCounterJournal(file, run.targets);
    runInNewContext(`${code}\nchoose(true); choose(false);`, { __coverage__: data });
    const recovered = replayCounterJournal(file);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].coverage).toEqual(JSON.parse(JSON.stringify(data[path])));
    expect(recovered[0].coverage.f['0']).toBe(2);
    expect(recovered[0].coverage.b['0']).toEqual([1, 1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
