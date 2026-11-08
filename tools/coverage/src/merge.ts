import { isDeepStrictEqual } from 'node:util';
import { createCoverageMap } from '@vitest/istanbul-lib-coverage';
import type { SourceCoverageData } from '@vitest/istanbul-lib-instrument';

export interface CoverageTarget {
  path: string;
  sourceHash: string;
  instrumentationHash: string;
  coverage: SourceCoverageData;
}

export interface CoverageRun {
  runId: string;
  revision: string;
  requiredSuites: readonly string[];
  targets: readonly CoverageTarget[];
}

export interface Measurement {
  formatVersion: 1;
  captureId: string;
  runId: string;
  revision: string;
  suite: string;
  status: 'complete' | 'failed' | 'incomplete';
  failure?: string;
  files: readonly CoverageTarget[];
}

function validateCounts(file: CoverageTarget): void {
  const { s, f, b, statementMap, fnMap, branchMap } = file.coverage;
  const keys = (value: object) => Object.keys(value).sort();
  if (
    !isDeepStrictEqual(keys(s), keys(statementMap)) ||
    !isDeepStrictEqual(keys(f), keys(fnMap)) ||
    !isDeepStrictEqual(keys(b), keys(branchMap)) ||
    Object.entries(b).some(([key, counts]) => counts.length !== branchMap[key].locations.length)
  ) {
    throw new Error(`カウンターの構造が一致しません: ${file.path}`);
  }
  const counts = [
    ...Object.values(file.coverage.s),
    ...Object.values(file.coverage.f),
    ...Object.values(file.coverage.b).flat(),
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error(`不正な実行回数: ${file.path}`);
  }
}

function definition(coverage: SourceCoverageData) {
  // JSON保存で省略されるundefinedを、実行前の位置定義と同じ形へ揃える。
  return JSON.parse(
    JSON.stringify({
      path: coverage.path,
      statementMap: coverage.statementMap,
      fnMap: coverage.fnMap,
      branchMap: coverage.branchMap,
      inputSourceMap: coverage.inputSourceMap,
    }),
  );
}

/** 共通の計測位置を持つ記録を統合する。入力は次の実行へ流用できるよう保持する。 */
export function mergeMeasurements(run: CoverageRun, records: readonly Measurement[]) {
  const targets = new Map(run.targets.map((target) => [target.path, target]));
  const combined = createCoverageMap({});
  for (const target of run.targets) {
    validateCounts(target);
    combined.addFileCoverage(structuredClone(target.coverage));
  }
  const captures = new Set<string>();
  for (const record of records) {
    if (captures.has(record.captureId)) {
      throw new Error(`計測片が重複しています: ${record.captureId}`);
    }
    captures.add(record.captureId);
    if (
      record.formatVersion !== 1 ||
      record.runId !== run.runId ||
      record.revision !== run.revision ||
      !run.requiredSuites.includes(record.suite)
    ) {
      throw new Error(`計測片の識別情報が一致しません: ${record.captureId}`);
    }
    if (record.status !== 'complete') {
      throw new Error(`収集が完了していません: ${record.captureId}`);
    }
    const paths = new Set<string>();
    for (const file of record.files) {
      if (paths.has(file.path)) {
        throw new Error(`計測片内のファイルが重複しています: ${file.path}`);
      }
      paths.add(file.path);
      const target = targets.get(file.path);
      if (!target || !isDeepStrictEqual(definition(target.coverage), definition(file.coverage))) {
        throw new Error(`計測位置が一致しません: ${file.path}`);
      }
      if (file.sourceHash !== target.sourceHash) {
        throw new Error(`ソースのハッシュが一致しません: ${file.path}`);
      }
      if (file.instrumentationHash !== target.instrumentationHash) {
        throw new Error(`計測コードのハッシュが一致しません: ${file.path}`);
      }
      validateCounts(file);
      combined.addFileCoverage(structuredClone(file.coverage));
    }
  }
  for (const suite of run.requiredSuites) {
    if (!records.some((record) => record.suite === suite)) {
      throw new Error(`必須suiteが欠落しています: ${suite}`);
    }
  }
  const observed = new Set(records.flatMap((record) => record.files.map((file) => file.path)));
  for (const target of run.targets) {
    if (!observed.has(target.path)) {
      throw new Error(`ファイルの計測記録が欠落しています: ${target.path}`);
    }
  }
  return combined;
}
