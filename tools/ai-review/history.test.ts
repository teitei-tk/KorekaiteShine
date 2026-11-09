import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readHistory, historyMarker, readInlineHistory, reviewHistory } from './history.ts';
import { renderReview } from './policy.ts';

it('旧指摘と行指摘を合計して30件を超える場合も拒否する', () => {
  const legacy = Array.from({ length: 30 }, (_, index) => ({
    id: index + 2,
    user: bot,
    body: renderReview(review, head, base),
  }));
  expect(() => reviewHistory(legacy, [inlineComment()], 'd'.repeat(40), base)).toThrow(
    '30件を超えました',
  );
});

it('headが同じでもbaseが違う指摘は修正確認対象に残す', () => {
  expect(reviewHistory([], [inlineComment()], head, 'd'.repeat(40))).toHaveLength(1);
});

it('構造化した指摘行と元コメントの行が違えば拒否する', () => {
  const comment = inlineComment();
  comment.original_line++;
  expect(() => readInlineHistory([comment])).toThrow('行コメントの対象が一致しません');
});

it('行コメントに指摘が一件もなければ履歴として拒否する', () => {
  const comment = inlineComment();
  comment.body = renderReview({ ...review, findings: [] }, head, base) + '\n' + historyMarker([]);
  expect(() => readInlineHistory([comment])).toThrow('行コメントの指摘履歴が不正');
});

it('旧形式の指摘なしコメントは空の履歴として読む', () => {
  expect(
    readHistory([
      { id: 1, user: bot, body: renderReview({ ...review, findings: [] }, head, base) },
    ]),
  ).toEqual([]);
});

it('旧形式の見出しに対応する本文が欠けた指摘を黙って落とさない', () => {
  const comment = inlineComment();
  comment.body =
    renderReview({ ...review, findings: [] }, head, base) + '\n**P1 — src/a.ts:2**\n\n壊れた本文';
  expect(() => readHistory([comment])).toThrow('旧指摘の読み取りに失敗');
});

it('構造化マーカーの形式が壊れていれば旧形式へ読み替えない', () => {
  const comment = inlineComment();
  comment.body = renderReview(review, head, base) + '\n<!-- findings:v1: -->';
  expect(() => readHistory([comment])).toThrow('指摘履歴が不正');
});

it('対象リビジョンが欠落したボットコメントを履歴として拒否する', () => {
  const comment = inlineComment();
  comment.body = comment.body.replace(/<!-- revision:.* -->/u, '');
  expect(() => readHistory([comment])).toThrow('過去のレビュー対象が不正');
});

function inlineComment(id = 1) {
  return {
    id,
    user: bot,
    body: renderReview(review, head, base) + '\n' + historyMarker([finding]),
    path: finding.path,
    line: finding.line,
    original_line: finding.line,
    commit_id: head,
    original_commit_id: head,
  };
}

it('修正返信のマーカーを含むコメントを新しい指摘として読み取らない', () => {
  const comment = inlineComment();
  comment.body += `\n<!-- followup:1:1:${head}:${base} -->`;
  expect(readHistory([comment])).toEqual([]);
});
const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const finding = {
  priority: 'P1' as const,
  path: 'src/a.ts',
  line: 2,
  condition: '切断時',
  impact: '停止',
  fix: '解放',
};
const bot = { login: 'github-actions[bot]', type: 'Bot' };
const review = {
  status: 'complete' as const,
  summary: '確認',
  uncertainties: [],
  findings: [finding],
};
it('旧形式と構造化履歴の元指摘を読み、人間の偽装を無視する', () => {
  const old = renderReview(review, head, base);
  expect(readHistory([{ id: 12, user: bot, body: old }])).toEqual([
    { id: '12:1', head, base, ...finding },
  ]);
  const body = old + '\n' + historyMarker([finding]);
  expect(readHistory([{ id: 12, user: bot, body }])).toHaveLength(1);
  expect(readHistory([{ id: 12, user: { login: 'human', type: 'User' }, body }])).toEqual([]);
});
it('破損した履歴と上限超過は黙って指摘を落とさず拒否する', () => {
  expect(() =>
    readHistory([
      {
        id: 12,
        user: bot,
        body: renderReview(review, head, base) + '\n<!-- findings:v1:invalid -->',
      },
    ]),
  ).toThrow();
  expect(() =>
    readHistory(
      Array.from({ length: 31 }, (_, i) => ({
        id: i + 1,
        user: bot,
        body: renderReview(review, head, base),
      })),
    ),
  ).toThrow();
});

it.each(['旧形式', '構造化形式'])('%sの同じ発生条件を持つ別々の指摘を保持する', (format) => {
  const findings = [
    { ...finding, condition: '接続に失敗した場合', impact: 'ソケットが解放されない' },
    {
      ...finding,
      line: 80,
      condition: '接続に失敗した場合',
      impact: '再試行回数が初期化され無限再試行する',
      fix: '再試行回数を保持する',
    },
  ];
  const body =
    renderReview({ ...review, findings }, head, base) +
    (format === '構造化形式' ? '\n' + historyMarker(findings) : '');
  expect(readHistory([{ id: 12, user: bot, body }])).toEqual(
    findings.map((f, index) => ({ ...f, id: `12:${index + 1}`, head, base })),
  );
});

it.each([
  { ...finding, impact: '' },
  { ...finding, line: 0 },
  { ...finding, priority: 'P3' },
])('履歴の不正な指摘形式は引き続き拒否する: %j', (invalid) => {
  const marker = `<!-- findings:v1:${Buffer.from(JSON.stringify([invalid])).toString('base64')} -->`;
  expect(() =>
    readHistory([{ id: 12, user: bot, body: renderReview(review, head, base) + '\n' + marker }]),
  ).toThrow();
});

it('保存した旧形式コメントを現在の生成関数に依存せず読み取れる', () => {
  const body = readFileSync(new URL('./fixtures/legacy-review.txt', import.meta.url), 'utf8');
  expect(readHistory([{ id: 12, user: bot, body }])).toEqual([
    {
      id: '12:1',
      head,
      base,
      priority: 'P1',
      path: 'src/a.ts',
      line: 2,
      condition: '接続に失敗した場合',
      impact: 'ソケットが解放されない',
      fix: 'ソケットを解放する',
    },
    {
      id: '12:2',
      head,
      base,
      priority: 'P2',
      path: 'src/a.ts',
      line: 80,
      condition: '接続に失敗した場合',
      impact: '再試行回数が初期化され無限再試行する',
      fix: '再試行回数を保持する',
    },
  ]);
});
