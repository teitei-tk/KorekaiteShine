import { isJsonObject } from './json.ts';
import type { JsonInput } from './json.ts';
import { ReviewFailure } from './failure.ts';
import { detail } from './diagnostics.ts';
import type { PriorFinding } from './history.ts';
export const REPOSITORY = 'teitei-tk/KorekaiteShine';
export const REPOSITORY_ID = 1_426_899_426;
export const OWNER_ID = 1_324_680;
export const MARKER = '<!-- korekaite-ai-review -->';

export type PullRequest = {
  number: number;
  user: { id: number; type: string };
  state: string;
  draft: boolean;
  head: { sha: string; repo: { id: number } | null };
  base: { sha: string; ref: string; repo: { id: number } };
  title?: string;
  body?: string | null;
};
export function eligible(value: JsonInput | undefined): value is PullRequest {
  const pr = value;
  return (
    pr !== undefined &&
    isJsonObject(pr) &&
    isJsonObject(pr.user) &&
    pr.user.id === OWNER_ID &&
    pr.user.type === 'User' &&
    isJsonObject(pr.head) &&
    isJsonObject(pr.head.repo) &&
    pr.head.repo.id === REPOSITORY_ID &&
    isJsonObject(pr.base) &&
    isJsonObject(pr.base.repo) &&
    pr.base.repo.id === REPOSITORY_ID &&
    pr.base.ref === 'main' &&
    pr.state === 'open' &&
    !Boolean(pr.draft) &&
    typeof pr.number === 'number' &&
    Number.isSafeInteger(pr.number) &&
    pr.number > 0 &&
    typeof pr.head.sha === 'string' &&
    /^[a-f0-9]{40}$/u.test(pr.head.sha) &&
    typeof pr.base.sha === 'string' &&
    /^[a-f0-9]{40}$/u.test(pr.base.sha)
  );
}
export type Finding = {
  priority: 'P1' | 'P2';
  path: string;
  line: number;
  condition: string;
  impact: string;
  fix: string;
};
export type FixCheck = {
  id: string;
  status: 'fixed' | 'unfixed' | 'unverified';
  evidence: string;
};
export type Review = {
  status: 'complete' | 'incomplete';
  summary: string;
  uncertainties: string[];
  findings: Finding[];
  checks?: FixCheck[];
};
function shortText(value: JsonInput | undefined, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
export type FindingInput = {
  priority: string;
  path: string;
  line: number;
  condition: string;
  impact: string;
  fix: string;
};
export type ReviewInput = {
  status: string;
  summary: string;
  uncertainties: string[];
  findings: FindingInput[];
  checks?: { id: string; status: string; evidence: string }[];
};
// 投稿済みの履歴にも使う形式検証。新規投稿の重複判定は含めない。
export function validFindings(value: JsonInput | undefined): Finding[] {
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    !value.every(
      (f): f is Finding =>
        isJsonObject(f) &&
        (f.priority === 'P1' || f.priority === 'P2') &&
        shortText(f.path, 500) &&
        typeof f.line === 'number' &&
        Number.isSafeInteger(f.line) &&
        f.line >= 1 &&
        shortText(f.condition, 1000) &&
        shortText(f.impact, 1000) &&
        shortText(f.fix, 1000),
    )
  ) {
    throw new Error('指摘の形式が不正です');
  }
  return value;
}
export function validReview(
  value: JsonInput,
  lines: Record<string, number[]>,
  prior: PriorFinding[] = [],
): Review {
  const r = value;
  if (
    !isJsonObject(r) ||
    (r.status !== 'complete' && r.status !== 'incomplete') ||
    !shortText(r.summary, 1500) ||
    !Array.isArray(r.uncertainties) ||
    r.uncertainties.length > 5 ||
    !r.uncertainties.every((x): x is string => shortText(x, 500))
  ) {
    throw new ReviewFailure(
      'OUTPUT_INVALID',
      'レビュー形式が不正です',
      detail('REVIEW_FORMAT_INVALID'),
    );
  }
  const findings = validFindings(r.findings);
  for (const f of findings) {
    if (!Object.hasOwn(lines, f.path) || !lines[f.path]?.includes(f.line)) {
      throw new ReviewFailure(
        'OUTPUT_INVALID',
        '指摘の変更行が不正です',
        detail('FINDING_LOCATION_INVALID'),
      );
    }
  }
  if (
    findings.some((f, index) =>
      [...prior, ...findings.slice(0, index)].some(
        (p) => p.path === f.path && p.condition.trim() === f.condition.trim(),
      ),
    )
  ) {
    throw new ReviewFailure(
      'OUTPUT_INVALID',
      '既存または新規の指摘が重複しています',
      detail('FINDING_DUPLICATE'),
    );
  }
  const checks = r.checks ?? [];
  if (
    !Array.isArray(checks) ||
    checks.length !== prior.length ||
    !checks.every(
      (c): c is { id: string; status?: JsonInput; evidence?: JsonInput } =>
        isJsonObject(c) && typeof c.id === 'string' && prior.some((f) => f.id === c.id),
    ) ||
    new Set(checks.map((c) => c.id)).size !== checks.length
  ) {
    throw new ReviewFailure(
      'OUTPUT_INVALID',
      '修正確認の対象または根拠が不正です',
      detail('CHECK_TARGET_MISMATCH'),
    );
  }
  if (
    !checks.every(
      (c): c is FixCheck =>
        (c.status === 'fixed' || c.status === 'unfixed' || c.status === 'unverified') &&
        shortText(c.evidence, 500),
    )
  ) {
    throw new ReviewFailure(
      'OUTPUT_INVALID',
      '修正確認の対象または根拠が不正です',
      detail('CHECK_RESULT_INVALID'),
    );
  }
  return {
    ...r,
    status: r.status,
    summary: r.summary,
    uncertainties: r.uncertainties,
    findings,
    ...(r.checks === undefined ? {} : { checks }),
  };
}
// MarkdownをHTML化して挿入させず、@による通知も発生させない。
export function safe(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '@\u200B')
    .replaceAll(/[\\`*_[\]#!|]/gu, String.raw`\$&`);
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
  if (r.uncertainties.length > 0) {
    parts.push(`未確認事項:\n${r.uncertainties.map((x) => `- ${safe(x)}`).join('\n')}`);
  }
  parts.push('指摘がない場合も、不具合がないことを保証しません。');
  return parts.join('\n\n');
}
