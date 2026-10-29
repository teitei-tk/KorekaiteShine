import { ReviewFailure } from './failure.ts';
import { detail } from './diagnostics.ts';
import type { PriorFinding } from './history.ts';
export const REPOSITORY = 'teitei-tk/KorekaiteShine';
export const REPOSITORY_ID = 1426899426;
export const OWNER_ID = 1324680;
export const MARKER = '<!-- korekaite-ai-review -->';

export interface PullRequest {
  number: number;
  user: { id: number; type: string };
  state: string;
  draft: boolean;
  head: { sha: string; repo: { id: number } | null };
  base: { sha: string; ref: string; repo: { id: number } };
  title?: string;
  body?: string | null;
}
export function eligible(value: Partial<PullRequest> | null): value is PullRequest {
  const pr = value as PullRequest | null;
  return (
    !!pr &&
    pr.user?.id === OWNER_ID &&
    pr.user.type === 'User' &&
    pr.head?.repo?.id === REPOSITORY_ID &&
    pr.base?.repo?.id === REPOSITORY_ID &&
    pr.base.ref === 'main' &&
    pr.state === 'open' &&
    pr.draft === false &&
    Number.isSafeInteger(pr.number) &&
    pr.number > 0 &&
    /^[a-f0-9]{40}$/.test(pr.head.sha) &&
    /^[a-f0-9]{40}$/.test(pr.base.sha)
  );
}
export interface Finding {
  priority: 'P1' | 'P2';
  path: string;
  line: number;
  condition: string;
  impact: string;
  fix: string;
}
export interface FixCheck {
  id: string;
  status: 'fixed' | 'unfixed' | 'unverified';
  evidence: string;
}
export interface Review {
  status: 'complete' | 'incomplete';
  summary: string;
  uncertainties: string[];
  findings: Finding[];
  checks?: FixCheck[];
}
function shortText(value: string | null | undefined, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
export interface FindingInput {
  priority: string;
  path: string;
  line: number;
  condition: string;
  impact: string;
  fix: string;
}
export interface ReviewInput {
  status: string;
  summary: string;
  uncertainties: string[];
  findings: FindingInput[];
  checks?: { id: string; status: string; evidence: string }[];
}
// 投稿済みの履歴にも使う形式検証。新規投稿の重複判定は含めない。
export function validFindings(value: FindingInput[] | null | undefined): Finding[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error('指摘の形式が不正です');
  for (const f of value) {
    if (
      !f ||
      !['P1', 'P2'].includes(f.priority) ||
      !shortText(f.path, 500) ||
      !Number.isSafeInteger(f.line) ||
      f.line < 1 ||
      !shortText(f.condition, 1000) ||
      !shortText(f.impact, 1000) ||
      !shortText(f.fix, 1000)
    )
      throw new Error('指摘の形式が不正です');
  }
  return value as Finding[];
}
export function validReview(
  value: ReviewInput | null,
  lines: Record<string, number[]>,
  prior: PriorFinding[] = [],
): Review {
  const r = value as Review | null;
  if (
    !r ||
    !['complete', 'incomplete'].includes(r.status) ||
    !shortText(r.summary, 1500) ||
    !Array.isArray(r.uncertainties) ||
    r.uncertainties.length > 5 ||
    !r.uncertainties.every((x) => shortText(x, 500))
  )
    throw new ReviewFailure(
      'OUTPUT_INVALID',
      'レビュー形式が不正です',
      detail('REVIEW_FORMAT_INVALID'),
    );
  const findings = validFindings(r.findings);
  for (const f of findings) {
    if (!Object.hasOwn(lines, f.path) || !lines[f.path]?.includes(f.line))
      throw new ReviewFailure(
        'OUTPUT_INVALID',
        '指摘の変更行が不正です',
        detail('FINDING_LOCATION_INVALID'),
      );
  }
  if (
    r.findings.some((f, index) =>
      [...prior, ...r.findings.slice(0, index)].some(
        (p) => p.path === f.path && p.condition.trim() === f.condition.trim(),
      ),
    )
  )
    throw new ReviewFailure(
      'OUTPUT_INVALID',
      '既存または新規の指摘が重複しています',
      detail('FINDING_DUPLICATE'),
    );
  const checks = r.checks ?? [];
  if (
    !Array.isArray(checks) ||
    checks.length !== prior.length ||
    new Set(checks.map((c) => c?.id)).size !== checks.length ||
    checks.some((c) => !c || !prior.some((f) => f.id === c.id))
  )
    throw new ReviewFailure(
      'OUTPUT_INVALID',
      '修正確認の対象または根拠が不正です',
      detail('CHECK_TARGET_MISMATCH'),
    );
  if (
    checks.some(
      (c) => !['fixed', 'unfixed', 'unverified'].includes(c.status) || !shortText(c.evidence, 500),
    )
  )
    throw new ReviewFailure(
      'OUTPUT_INVALID',
      '修正確認の対象または根拠が不正です',
      detail('CHECK_RESULT_INVALID'),
    );
  return r;
}
// MarkdownをHTML化して挿入させず、@による通知も発生させない。
export function safe(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '@\u200b')
    .replace(/[\\`*_[\]#!|]/g, '\\$&');
}
export function revisionMarker(head: string, base: string): string {
  return `<!-- revision:${head}:${base} -->`;
}
export function renderReview(r: Review, head: string, base: string): string {
  const parts = [
    MARKER,
    revisionMarker(head, base),
    `### AIレビュー（${r.status === 'complete' ? '完了' : '未完了'}）`,
    `対象: \`${head}\` / base: \`${base}\``,
    'モデル: gpt-6-luna。参考情報であり、マージ判定ではありません。',
    safe(r.summary),
  ];
  for (const f of r.findings) {
    parts.push(
      `**${f.priority} — ${safe(f.path)}:${f.line}**\n\n発生条件: ${safe(f.condition)}\n\n影響: ${safe(f.impact)}\n\n修正方針: ${safe(f.fix)}`,
    );
  }
  if (r.uncertainties.length)
    parts.push('未確認事項:\n' + r.uncertainties.map((x) => `- ${safe(x)}`).join('\n'));
  parts.push('指摘がない場合も、不具合がないことを保証しません。');
  return parts.join('\n\n');
}
