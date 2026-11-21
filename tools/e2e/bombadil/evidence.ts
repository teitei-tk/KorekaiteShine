import { parseJson } from '@korekaite/api-contracts/json';
import type { ExplorationResult, ExplorationTarget } from './types.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = Record<string, Json>;

export const requiredCoverage: Record<ExplorationTarget, readonly string[]> = {
  preparation: [
    'analyzed',
    'edited-after-confirmation',
    'blocked-unconfirmed',
    'delayed-analysis-isolated',
  ],
  history: [
    'opened-a',
    'opened-b',
    'cancelled-delete',
    'deleted-and-reloaded',
    'delayed-detail-isolated',
  ],
};

function isRecord(value: Json | undefined): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAction(value: Json | undefined): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value === 'string') {
    return ['Back', 'Forward', 'Reload', 'Wait'].includes(value);
  }
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    return false;
  }
  if ('Custom' in value) {
    return (
      isRecord(value.Custom) &&
      typeof value.Custom.name === 'string' &&
      value.Custom.name.length > 0 &&
      Array.isArray(value.Custom.arguments)
    );
  }
  return Object.entries(value).every(
    ([name, payload]) =>
      [
        'Click',
        'DoubleClick',
        'TypeText',
        'PressKey',
        'ScrollUp',
        'ScrollDown',
        'SetFileInputFiles',
        'MouseDrag',
        'SetViewport',
      ].includes(name) && isRecord(payload),
  );
}

export type ExplorationEvidenceInput = {
  target: ExplorationTarget;
  exitCode: number | null;
  interrupted?: boolean;
};

/** 各行を検証し、判定に必要な件数と最後の確認状態だけを保持する。 */
export function createExplorationSummary(input: ExplorationEvidenceInput) {
  const counts = {
    actions: 0,
    violations: 0,
    coverageSnapshots: 0,
    pendingDeletions: true,
    lines: 0,
    invalid: false,
  };
  const reached = new Set<string>();
  const result = (
    status: ExplorationResult['status'],
  ): Omit<ExplorationResult, 'artifactDirectory'> => ({
    status,
    actions: counts.actions,
    reached: [...reached],
  });
  const fail = () => {
    counts.invalid = true;
  };
  const add = (line: string) => {
    if (counts.invalid || !line.trim()) {
      return;
    }
    counts.lines++;
    try {
      const row: Json = parseJson(line);
      if (
        !isRecord(row) ||
        !isAction(row.action) ||
        !Array.isArray(row.snapshots) ||
        !Array.isArray(row.violations)
      ) {
        fail();
        return;
      }
      if (row.action !== null && row.action !== 'Wait') {
        counts.actions++;
      }
      for (const violation of row.violations) {
        if (!isRecord(violation) || typeof violation.name !== 'string' || !violation.name) {
          fail();
          return;
        }
        counts.violations++;
      }
      for (const snapshot of row.snapshots) {
        if (!isRecord(snapshot) || typeof snapshot.name !== 'string') {
          fail();
          return;
        }
        if (snapshot.name !== 'coverage') {
          continue;
        }
        if (!isRecord(snapshot.value) || !Array.isArray(snapshot.value.reached)) {
          fail();
          return;
        }
        counts.coverageSnapshots++;
        if (input.target === 'history') {
          const pending = snapshot.value.pendingDeletions;
          if (
            pending !== null &&
            (!Array.isArray(pending) ||
              pending.some((id) => typeof id !== 'string' || id.length === 0))
          ) {
            fail();
            return;
          }
          // 到達条件は累積するが、未確認の削除は最後の観測で判定する。
          counts.pendingDeletions = pending === null || pending.length > 0;
        }
        for (const marker of snapshot.value.reached) {
          if (typeof marker !== 'string' || !requiredCoverage[input.target].includes(marker)) {
            fail();
            return;
          }
          reached.add(marker);
        }
      }
    } catch {
      fail();
    }
  };
  const finish = () => {
    if (counts.invalid || counts.lines === 0 || !counts.coverageSnapshots) {
      return result('infrastructure_error');
    }
    if (input.exitCode === 2 && counts.violations > 0) {
      return result('violated');
    }
    if (input.interrupted) {
      return result('incomplete');
    }
    if (input.exitCode !== 0 || counts.violations > 0) {
      return result('infrastructure_error');
    }
    if (
      counts.actions > 0 &&
      (input.target !== 'history' || !counts.pendingDeletions) &&
      requiredCoverage[input.target].every((marker) => reached.has(marker))
    ) {
      return result('passed');
    }
    return result('incomplete');
  };
  return { add, finish };
}

/** 小さい固定記録を使う検査も、実ファイルと同じ集計器を通す。 */
export function summarizeExploration(input: ExplorationEvidenceInput & { trace: string }) {
  const summary = createExplorationSummary(input);
  for (const line of input.trace.split('\n')) {
    summary.add(line);
  }
  return summary.finish();
}
