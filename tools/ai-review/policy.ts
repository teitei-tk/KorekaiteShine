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
export function eligible(value: unknown): value is PullRequest {
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
export function remainingLifetime(value: unknown, now = Math.floor(Date.now() / 1000)): number {
  const expiry = (value as { expires_at?: unknown })?.expires_at;
  if (typeof expiry !== 'number' || !Number.isSafeInteger(expiry) || expiry - now < 240) {
    throw new Error('WIFトークンの残存時間が240秒未満または不明です');
  }
  return expiry - now;
}
export interface Finding {
  priority: 'P1' | 'P2';
  path: string;
  line: number;
  condition: string;
  impact: string;
  fix: string;
}
export interface Review {
  status: 'complete' | 'incomplete';
  summary: string;
  uncertainties: string[];
  findings: Finding[];
}
function shortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
export function validReview(value: unknown, lines: Record<string, number[]>): Review {
  const r = value as Review | null;
  if (
    !r ||
    !['complete', 'incomplete'].includes(r.status) ||
    !shortText(r.summary, 1500) ||
    !Array.isArray(r.uncertainties) ||
    r.uncertainties.length > 5 ||
    !r.uncertainties.every((x) => shortText(x, 500)) ||
    !Array.isArray(r.findings) ||
    r.findings.length > 3
  )
    throw new Error('レビュー形式が不正です');
  for (const f of r.findings) {
    if (
      !f ||
      !['P1', 'P2'].includes(f.priority) ||
      !shortText(f.path, 500) ||
      !Object.hasOwn(lines, f.path) ||
      !lines[f.path]?.includes(f.line) ||
      !shortText(f.condition, 1000) ||
      !shortText(f.impact, 1000) ||
      !shortText(f.fix, 1000)
    ) {
      throw new Error('指摘の内容または変更行が不正です');
    }
  }
  return r;
}
// MarkdownをHTML化して挿入させず、@による通知も発生させない。
function safe(value: string): string {
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
