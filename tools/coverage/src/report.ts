import { mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import { createCoverageMap, type CoverageMap } from '@vitest/istanbul-lib-coverage';
import { createSourceMapStore } from '@vitest/istanbul-lib-source-maps';
import { create, createContext } from '@vitest/istanbul-lib-report';
import type { SourceCoverageData } from '@vitest/istanbul-lib-instrument';

export async function writeReports(raw: CoverageMap, directory: string, root = process.cwd()) {
  const absolute = createCoverageMap({});
  for (const path of raw.files()) {
    const data = structuredClone(raw.fileCoverageFor(path).toJSON()) as SourceCoverageData;
    data.path = resolve(root, path);
    if (data.inputSourceMap) {
      data.inputSourceMap.sources = data.inputSourceMap.sources.map((source) =>
        resolve(root, source!),
      );
    }
    absolute.addFileCoverage(data);
  }
  const store = createSourceMapStore();
  const mapped = await store.transformCoverage(absolute);
  // ライブラリが落とす要素0件のファイルも、台帳の一員として保持する。
  for (const path of absolute.files()) {
    if (!mapped.files().includes(path)) {
      const data = absolute.fileCoverageFor(path);
      if (data.toSummary().isEmpty()) {
        mapped.addFileCoverage(data);
      } else {
        throw new Error(`元ソースへの変換でファイルが失われました: ${path}`);
      }
    }
  }
  const result = createCoverageMap({});
  for (const path of mapped.files()) {
    const data = mapped.fileCoverageFor(path).toJSON();
    result.addFileCoverage({ ...data, path: relative(root, path) });
  }
  mkdirSync(directory, { recursive: true });
  const context = createContext({
    dir: directory,
    coverageMap: result,
    sourceFinder: (path) => store.sourceFinder(resolve(root, path)),
  });
  create('json').execute(context);
  create('html').execute(context);
  const rows = result
    .files()
    .sort()
    .map((path) => {
      const file = result.fileCoverageFor(path);
      const summary = file.toSummary().toJSON();
      const metrics = ['lines', 'statements', 'functions', 'branches'] as const;
      const state = metrics.every((metric) => summary[metric].total === 0)
        ? 'zero'
        : metrics.every((metric) => summary[metric].covered === 0)
          ? 'unexecuted'
          : metrics.every((metric) => summary[metric].covered === summary[metric].total)
            ? 'complete'
            : 'partial';
      return {
        path,
        state,
        ...(state === 'zero'
          ? { reason: '型除去・変換後に計測要素がないため、4指標の分母は0件' }
          : {}),
        summary,
        missing: {
          lines: Object.entries(file.getLineCoverage())
            .filter(([, count]) => count === 0)
            .map(([line]) => Number(line)),
          statements: Object.entries(file.s)
            .filter(([, count]) => count === 0)
            .map(([id]) => file.statementMap[id]),
          functions: Object.entries(file.f)
            .filter(([, count]) => count === 0)
            .map(([id]) => file.fnMap[id]),
          branches: Object.entries(file.b).flatMap(([id, counts]) =>
            counts.flatMap((count, index) => {
              const branch = file.branchMap[id];
              const location = branch.locations[index];
              return count === 0
                ? [
                    {
                      id,
                      index,
                      type: branch.type,
                      location: Number.isInteger(location.start.line) ? location : branch.loc,
                    },
                  ]
                : [];
            }),
          ),
        },
      };
    });
  writeFileSync(join(directory, 'files.json'), JSON.stringify(rows, null, 2));
  writeFileSync(
    join(directory, 'missing.json'),
    JSON.stringify(
      rows.filter((row) => Object.values(row.missing).some((items) => items.length > 0)),
      null,
      2,
    ),
  );
  store.dispose();
  return result;
}
