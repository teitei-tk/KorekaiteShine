import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { combineShards, coverageSuites, mergeSavedShards, saveShard } from '../src/shards.ts';
import { createMergeFixture } from './fixtures/measurement.ts';

function fixture() {
  const { run, records } = createMergeFixture();
  run.requiredSuites = coverageSuites;
  const shards = [1, 2, 3, 4].map((shard) => {
    const shardRun = structuredClone(run);
    shardRun.runId = `run-${shard}`;
    return {
      shard,
      run: shardRun,
      records: coverageSuites.map((suite, index) => {
        const record = structuredClone(records[shard % 2]);
        record.runId = shardRun.runId;
        record.captureId = `capture-${index}`;
        record.suite = suite;
        return record;
      }),
    };
  });
  return { run, shards };
}

test('別runnerの相補的な実行を統合し全分岐を数える', () => {
  const { run, shards } = fixture();
  expect(combineShards(run, shards).getCoverageSummary().branches.pct).toBe(100);
});

test('シャード欠落を拒否する', () => {
  const { run, shards } = fixture();
  expect(() => combineShards(run, shards.slice(1))).toThrow('シャード');
});

test('重複シャードを拒否する', () => {
  const { run, shards } = fixture();
  shards[1].shard = 1;
  expect(() => combineShards(run, shards)).toThrow('シャード');
});

test('別revisionを拒否する', () => {
  const { run, shards } = fixture();
  shards[1].run.revision = 'old';
  expect(() => combineShards(run, shards)).toThrow('台帳');
});

test('異なる対象集合を拒否する', () => {
  const { run, shards } = fixture();
  shards[1].run.targets = [];
  expect(() => combineShards(run, shards)).toThrow('台帳');
});

test('必須suiteを減らした台帳を拒否する', () => {
  const { run, shards } = fixture();
  shards[1].run.requiredSuites = ['tests'];
  expect(() => combineShards(run, shards)).toThrow('台帳');
});

test('失敗した計測片を拒否する', () => {
  const { run, shards } = fixture();
  shards[1].records[0].status = 'failed';
  expect(() => combineShards(run, shards)).toThrow('完了');
});

test('他の実行の計測片を番号付替え前に拒否する', () => {
  const { run, shards } = fixture();
  shards[1].records[0].runId = 'old';
  expect(() => combineShards(run, shards)).toThrow('識別');
});

function savedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'coverage-shards-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const { source, path } = createMergeFixture();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, path), source);
  const { run, shards } = fixture();
  for (const shard of shards) {
    saveShard(root, shard.shard, shard.run, shard.records);
  }
  return { root, path, run, shards };
}

test('保存した4シャードを現在のソースで照合し100%のレポートを作る', async () => {
  const { root, path, run } = savedFixture();
  const result = await mergeSavedShards(root, [path], run.revision);
  expect(result.getCoverageSummary().branches.pct).toBe(100);
  expect(readFileSync(join(root, 'coverage/combined/index.html'), 'utf8')).toContain('choose.ts');
});

test('成果物の番号偽装を拒否する', async () => {
  const { root, path, run, shards } = savedFixture();
  writeFileSync(join(root, 'coverage/shards/1.json'), JSON.stringify(shards[1]));
  await expect(mergeSavedShards(root, [path], run.revision)).rejects.toThrow('番号');
});

test('成果物欠落を拒否する', async () => {
  const { root, path, run } = savedFixture();
  rmSync(join(root, 'coverage/shards/4.json'));
  await expect(mergeSavedShards(root, [path], run.revision)).rejects.toThrow('ENOENT');
});

test('全シャードが成功しても未実行分岐があれば100%判定で失敗する', async () => {
  const { root, path, run, shards } = savedFixture();
  for (const shard of shards) {
    saveShard(
      root,
      shard.shard,
      shard.run,
      shards[0].records.map((record) => {
        const copy = structuredClone(record);
        copy.runId = shard.run.runId;
        return copy;
      }),
    );
  }
  await expect(mergeSavedShards(root, [path], run.revision)).rejects.toThrow('カバレッジ不足');
});

test('番号だけ変えて同じ計測実行を複製したシャードを拒否する', () => {
  const { run, shards } = fixture();
  shards[1].run = structuredClone(shards[0].run);
  shards[1].records = structuredClone(shards[0].records);
  expect(() => combineShards(run, shards)).toThrow('実行ID');
});
