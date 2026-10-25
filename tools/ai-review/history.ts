import { ownComment } from './github.ts';
import type { Comment } from './github.ts';
import { validFindings } from './policy.ts';
import type { Finding } from './policy.ts';

export interface PriorFinding extends Finding {
  id: string;
  head: string;
  base: string;
}
export function historyMarker(findings: Finding[]): string {
  return `<!-- findings:v1:${Buffer.from(JSON.stringify(findings)).toString('base64')} -->`;
}
function unescape(value: string): string {
  return value
    .replace(/\\([\\`*_[\]#!|])/g, '$1')
    .replaceAll('@\u200b', '@')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}
export function readHistory(comments: Comment[]): PriorFinding[] {
  const history: PriorFinding[] = [];
  for (const comment of comments.filter(ownComment)) {
    const revision = /^<!-- revision:([a-f0-9]{40}):([a-f0-9]{40}) -->$/m.exec(comment.body);
    if (!revision || !Number.isSafeInteger(comment.id) || comment.id < 1)
      throw new Error('過去のレビュー対象が不正です');
    const marker = /^<!-- findings:v1:([A-Za-z0-9+/=]+) -->$/m.exec(comment.body);
    let rawFindings: unknown;
    if (comment.body.includes('<!-- findings:')) {
      if (!marker) throw new Error('指摘履歴が不正です');
      const value: unknown = JSON.parse(Buffer.from(marker[1], 'base64').toString('utf8'));
      rawFindings = value;
    } else {
      // 旧集約コメントの固定レンダリング形式だけを移行する。
      const pattern =
        /^\*\*(P1|P2) — (.+):(\d+)\*\*\n\n発生条件: ([\s\S]*?)\n\n影響: ([\s\S]*?)\n\n修正方針: ([\s\S]*?)(?=\n\n\*\*P[12] — |\n\n未確認事項:|\n\n指摘がない場合も、不具合がないことを保証しません。)/gm;
      const findings = [...comment.body.matchAll(pattern)].map((m) => ({
        priority: m[1] as 'P1' | 'P2',
        path: unescape(m[2]),
        line: Number(m[3]),
        condition: unescape(m[4]),
        impact: unescape(m[5]),
        fix: unescape(m[6]),
      }));
      if ((comment.body.match(/^\*\*P[12] — /gm) ?? []).length !== findings.length)
        throw new Error('旧指摘の読み取りに失敗しました');
      rawFindings = findings;
    }
    const findings = validFindings(rawFindings);
    findings.forEach((f, index) =>
      history.push({
        ...f,
        id: `${comment.id}:${index + 1}`,
        head: revision[1],
        base: revision[2],
      }),
    );
    if (history.length > 30) throw new Error('修正確認対象が30件を超えました');
  }
  return history;
}
