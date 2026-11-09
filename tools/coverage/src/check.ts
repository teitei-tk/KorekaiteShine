import type { CoverageMap } from '@vitest/istanbul-lib-coverage';

/** 丸められた百分率ではなく、ファイルごとの実数で4指標を検査する。 */
export function checkCoverage(coverage: CoverageMap): void {
  const metrics = ['lines', 'statements', 'functions', 'branches'] as const;
  const total = coverage.getCoverageSummary();
  if (metrics.every((metric) => total[metric].total === 0)) {
    throw new Error('計測要素がありません');
  }
  const missing: string[] = [];
  for (const path of coverage.files()) {
    const summary = coverage.fileCoverageFor(path).toSummary();
    const incomplete = metrics.filter(
      (metric) => summary[metric].covered !== summary[metric].total,
    );
    if (incomplete.length > 0) {
      missing.push(`${path} (${incomplete.join(', ')})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`カバレッジ不足: ${missing.join('; ')}`);
  }
}
