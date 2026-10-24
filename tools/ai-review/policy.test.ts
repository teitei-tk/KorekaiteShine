import { describe, expect, it } from 'vitest';
import { eligible, validReview, remainingLifetime, renderReview } from './policy.ts';

const sha = 'a'.repeat(40);
export function prFixture() {
  return {
    number: 7,
    user: { id: 1324680, type: 'User' },
    state: 'open',
    draft: false,
    head: { sha, repo: { id: 1426899426 } },
    base: { sha: 'b'.repeat(40), ref: 'main', repo: { id: 1426899426 } },
  };
}

describe('認証前のPR制限', () => {
  it('本人の同一リポジトリPRだけを許可する', () => expect(eligible(prFixture())).toBe(true));
  it.each(['other', 'fork', 'bot', 'draft', 'closed', 'base', 'missing'])(
    '%sを拒否する',
    (kind) => {
      const pr = prFixture();
      if (kind === 'other') pr.user.id = 123;
      if (kind === 'fork') pr.head.repo.id = 456;
      if (kind === 'bot') pr.user.type = 'Bot';
      if (kind === 'draft') pr.draft = true;
      if (kind === 'closed') pr.state = 'closed';
      if (kind === 'base') pr.base.ref = 'dev';
      expect(eligible(kind === 'missing' ? {} : pr)).toBe(false);
    },
  );
});

const result = {
  status: 'complete',
  summary: '確認しました',
  uncertainties: [],
  findings: [
    {
      priority: 'P1',
      path: 'src/app.ts',
      line: 2,
      condition: '切断時',
      impact: '停止する',
      fix: '解放する',
    },
  ],
};
const lines = { 'src/app.ts': [2, 3] };

describe('モデル出力の境界', () => {
  it('変更行にある指摘を受け入れる', () => expect(validReview(result, lines)).toEqual(result));
  it.each(['line', 'path', 'count', 'status', 'empty'])('%sが不正なら投稿しない', (kind) => {
    const r = structuredClone(result);
    if (kind === 'line') r.findings[0].line = 80;
    if (kind === 'path') r.findings[0].path = '../secret';
    if (kind === 'count') r.findings = Array(4).fill(r.findings[0]);
    if (kind === 'status') r.status = 'anything';
    if (kind === 'empty') r.findings[0].impact = '';
    expect(() => validReview(r, lines)).toThrow();
  });
  it('メンションとHTMLを投稿用テキストから無害化する', () => {
    const r = { ...result, summary: '@someone <img src=x>', findings: [] };
    const body = renderReview(validReview(r, lines), sha, 'b'.repeat(40));
    expect(body).not.toContain('@someone');
    expect(body).not.toContain('<img');
    expect(body).toContain(sha);
  });
  it('未完了を問題なしとして表示しない', () => {
    const r = validReview({ ...result, status: 'incomplete', findings: [] }, lines);
    expect(renderReview(r, sha, 'b'.repeat(40))).toContain('未完了');
  });
});

it('期限切れや残存240秒未満を拒否する', () => {
  expect(remainingLifetime({ expires_at: 1300 }, 1000)).toBe(300);
  for (const expires_at of [999, 1239, undefined, '1300']) {
    expect(() => remainingLifetime({ expires_at }, 1000)).toThrow();
  }
});
