import type { ReviewTask } from './partition.ts';
export const RESULT_BYTES = 30_000;
export const HISTORY_RESULT_BYTES = RESULT_BYTES - 2000; // 整形等の余白を確保する。
export const HISTORY_SUMMARY_CHARS = 300;
export const HISTORY_UNCERTAINTIES = 3;
export const HISTORY_UNCERTAINTY_CHARS = 150;
// JSONで最長のエスケープ（1文字6バイト）を用いて履歴応答の最大サイズを見積もる。
export function historyOutputBytes(task: ReviewTask): number {
  return Buffer.byteLength(
    JSON.stringify({
      status: 'incomplete',
      summary: '\u0000'.repeat(HISTORY_SUMMARY_CHARS),
      uncertainties: Array(HISTORY_UNCERTAINTIES).fill('\u0000'.repeat(HISTORY_UNCERTAINTY_CHARS)),
      findings: [],
      decisions: [],
      evidence: [],
      coverage: Object.fromEntries(task.obligations.map((id) => [id, true])),
      checks: task.priorIds.map((id) => ({
        id,
        status: 'unverified',
        evidence: '\u0000'.repeat(500),
      })),
      checkSources: task.priorIds.map((id) => ({ id, sources: task.sources })),
      incomplete: {
        subcode: 'UNRESOLVED_CONFLICT',
        missing: [
          'IMPLEMENTATION',
          'CALLER',
          'CONTRACT',
          'SPECIFICATION',
          'PRIOR_EVIDENCE',
          'REVIEWABLE_LINE',
        ],
      },
    }),
  );
}
