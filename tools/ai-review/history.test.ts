import { expect, it } from 'vitest';
import { readHistory, historyMarker } from './history.ts';
import { renderReview } from './policy.ts';
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
