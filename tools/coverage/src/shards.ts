import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { checkCoverage } from './check.ts';
import { mergeMeasurements } from './merge.ts';
import type { CoverageRun, Measurement } from './merge.ts';
import { prepareRun } from './prepare.ts';
import { writeReports } from './report.ts';
import { parse, readArray, readCoverageConfig, readMeasurement, readObject } from './schema.ts';

export const coverageSuites = [
  'inventory',
  'generate',
  'api-codegen',
  'prepare',
  'web-build',
  'tests',
];
const shardNumbers = [1, 2, 3, 4];
type Shard = { shard: number; run: CoverageRun; records: Measurement[] };

export function combineShards(current: CoverageRun, shards: readonly Shard[]) {
  if (
    !isDeepStrictEqual(
      shards.map((shard) => shard.shard).toSorted((a, b) => a - b),
      shardNumbers,
    )
  ) {
    throw new Error('カバレッジのシャードに欠落・重複・不正番号があります。');
  }
  if (new Set(shards.map((shard) => shard.run.runId)).size !== shards.length) {
    throw new Error('シャードの実行IDが重複しています。');
  }
  for (const shard of shards) {
    if (
      shard.run.revision !== current.revision ||
      !isDeepStrictEqual(
        parse(JSON.stringify(shard.run.targets)),
        parse(JSON.stringify(current.targets)),
      ) ||
      !isDeepStrictEqual(shard.run.requiredSuites, coverageSuites)
    ) {
      throw new Error('シャードの台帳が現在のソース・必須suiteと一致しません。');
    }
    // 識別子を統合用へ置換する前に元runnerの完了と全計測片を検証する。
    mergeMeasurements(shard.run, shard.records);
  }
  const run = {
    ...current,
    requiredSuites: shards.flatMap(({ shard }) =>
      coverageSuites.map((suite) => `${shard}/${suite}`),
    ),
  };
  const records = shards.flatMap(({ shard, records }) =>
    records.map((record) => ({
      ...record,
      captureId: `${shard}/${record.captureId}`,
      runId: run.runId,
      suite: `${shard}/${record.suite}`,
    })),
  );
  return mergeMeasurements(run, records);
}

export function saveShard(root: string, shard: number, run: CoverageRun, records: Measurement[]) {
  const directory = join(root, 'coverage', 'shards');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${shard}.json`), JSON.stringify({ shard, run, records }));
}

export async function mergeSavedShards(root: string, paths: readonly string[], revision: string) {
  const current = prepareRun(root, paths, revision, coverageSuites).run;
  const shards = shardNumbers.map((shard) => {
    const text = readFileSync(join(root, 'coverage', 'shards', `${shard}.json`), 'utf8');
    const data = readObject(parse(text));
    if (data.shard !== shard) {
      throw new Error('シャード番号が成果物と一致しません。');
    }
    return {
      shard,
      run: readCoverageConfig(text).run,
      records: readArray(data.records).map((record) => readMeasurement(JSON.stringify(record))),
    };
  });
  const combined = combineShards(current, shards);
  const coverage = await writeReports(combined, join(root, 'coverage', 'combined'), root);
  checkCoverage(coverage);
  return coverage;
}
