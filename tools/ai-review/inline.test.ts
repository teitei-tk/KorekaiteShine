import { expect, it } from 'vitest';
import { publish } from './publish.ts';
import { readInlineHistory, reviewHistory } from './history.ts';
import { historyMarker } from './history.ts';
import { MARKER, revisionMarker } from './policy.ts';
import type { Api, ApiBody, Comment, ReviewComment } from './github.ts';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  oldHead = 'c'.repeat(40);
const user = { login: 'github-actions[bot]', type: 'Bot' };
const finding = {
  priority: 'P2' as const,
  path: 'app.ts',
  line: 4,
  condition: '切断時',
  impact: '停止',
  fix: '解放',
};
const review = {
  status: 'complete',
  summary: '確認',
  uncertainties: [],
  findings: [finding],
  checks: [],
};
const metadata = { number: 7, head, base, lines: { 'app.ts': [4] } };
function fixture() {
  const issues: Comment[] = [];
  const inline: ReviewComment[] = [];
  const writes: { path: string; body: ApiBody }[] = [];
  let failReply = false,
    changed = false,
    failSummary = false,
    changeAfterWrite = false;
  const api: Api = async <T>(path: string, method?: string, body?: ApiBody) => {
    if (method) {
      if (failSummary && path === 'issues/7/comments') throw new Error('概要投稿失敗');
      if (failReply && path.endsWith('/replies')) throw new Error('通信失敗');
      writes.push({ path, body: body! });
      if (changeAfterWrite) changed = true;
      if (path === 'pulls/7/reviews' && body && 'comments' in body) {
        for (const c of body.comments)
          inline.push({
            ...c,
            id: 100 + inline.length,
            user,
            commit_id: head,
            original_commit_id: head,
            original_line: c.line,
          });
      } else if (path.endsWith('/replies')) {
        inline.push({
          ...inline[0],
          id: 200 + inline.length,
          body: body!.body,
          in_reply_to_id: Number(path.split('/')[3]),
        });
      } else issues.push({ id: 300 + issues.length, user, body: body!.body });
      return {} as T;
    }
    if (path.startsWith('issues/')) return issues as T;
    if (path.includes('/comments?')) return inline as T;
    return {
      number: 7,
      user: { id: 1324680, type: 'User' },
      state: 'open',
      draft: false,
      head: { sha: changed ? oldHead : head, repo: { id: 1426899426 } },
      base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
    } as T;
  };
  return {
    api,
    issues,
    inline,
    writes,
    summaryFailure: (value: boolean) => {
      failSummary = value;
    },
    changeOnWrite: () => {
      changeAfterWrite = true;
    },
    fail: (value: boolean) => {
      failReply = value;
    },
    change: () => {
      changed = true;
    },
  };
}
function root(id = 10): ReviewComment {
  return {
    id,
    user,
    body: `${MARKER}\n${revisionMarker(oldHead, base)}\n${historyMarker([finding])}`,
    path: 'app.ts',
    line: null,
    original_line: 4,
    commit_id: oldHead,
    original_commit_id: oldHead,
  };
}
it('指摘を対象SHA・RIGHT側行へ投稿し、概要には指摘本文を重複させない', async () => {
  const f = fixture();
  expect(await publish(f.api, metadata, review)).toBe(true);
  expect(f.writes[0]).toMatchObject({
    path: 'pulls/7/reviews',
    body: {
      commit_id: head,
      event: 'COMMENT',
      comments: [{ path: 'app.ts', line: 4, side: 'RIGHT' }],
    },
  });
  expect(f.inline[0].body).toContain('切断時');
  expect(f.issues[0].body).not.toContain('切断時');
  expect(await publish(f.api, metadata, review)).toBe(false);
  expect(f.writes).toHaveLength(2);
});
it.each(['fixed', 'unfixed', 'unverified'])(
  '古くなった元行のスレッドに%sを返信し、Resolveを操作しない',
  async (status) => {
    const f = fixture();
    f.inline.push(root());
    const priorFindings = readInlineHistory(f.inline);
    await publish(
      f.api,
      { ...metadata, priorFindings },
      { ...review, findings: [], checks: [{ id: priorFindings[0].id, status, evidence: '根拠' }] },
    );
    expect(f.writes.map((w) => w.path)).toEqual([
      'pulls/7/comments/10/replies',
      'issues/7/comments',
    ]);
    expect(f.writes[0].body.body).toContain(
      status === 'fixed' ? '☑️: 修正を確認しました' : '修正が確認できません',
    );
    expect(f.writes[0].body.body).toContain(head);
    expect(readInlineHistory(f.inline)).toEqual(priorFindings);
  },
);
it('一括投稿後に返信が失敗しても、再試行で新規スレッドを重複させない', async () => {
  const f = fixture();
  f.inline.push(root());
  const priorFindings = readInlineHistory(f.inline);
  const result = {
    ...review,
    findings: [{ ...finding, condition: '別の条件' }],
    checks: [{ id: priorFindings[0].id, status: 'fixed', evidence: '根拠' }],
  };
  f.fail(true);
  await expect(publish(f.api, { ...metadata, priorFindings }, result)).rejects.toThrow();
  f.fail(false);
  await publish(f.api, { ...metadata, priorFindings }, result);
  expect(f.writes.filter((w) => w.path === 'pulls/7/reviews')).toHaveLength(1);
  expect(f.writes.filter((w) => w.path.endsWith('/replies'))).toHaveLength(1);
});
it('投稿前にSHAが変わった場合は行コメントも作らない', async () => {
  const f = fixture();
  f.change();
  expect(await publish(f.api, metadata, review)).toBe(false);
  expect(f.writes).toEqual([]);
});

it('返信後の概要投稿に失敗しても返信を重複しない', async () => {
  const f = fixture();
  f.inline.push(root());
  const priorFindings = readInlineHistory(f.inline);
  const result = {
    ...review,
    findings: [],
    checks: [{ id: priorFindings[0].id, status: 'fixed', evidence: '根拠' }],
  };
  f.summaryFailure(true);
  await expect(publish(f.api, { ...metadata, priorFindings }, result)).rejects.toThrow();
  f.summaryFailure(false);
  await publish(f.api, { ...metadata, priorFindings }, result);
  expect(f.writes.filter((w) => w.path.endsWith('/replies'))).toHaveLength(1);
  expect(f.issues).toHaveLength(1);
});
it('行コメント投稿後のSHA変更では返信と完了記録を中止する', async () => {
  const f = fixture();
  f.inline.push(root());
  f.changeOnWrite();
  const priorFindings = readInlineHistory(f.inline);
  expect(
    await publish(
      f.api,
      { ...metadata, priorFindings },
      {
        ...review,
        findings: [{ ...finding, condition: '新条件' }],
        checks: [{ id: priorFindings[0].id, status: 'fixed', evidence: '根拠' }],
      },
    ),
  ).toBe(false);
  expect(f.writes.map((w) => w.path)).toEqual(['pulls/7/reviews']);
});
it('人間の行コメントと返信を指摘履歴として取り込まない', () => {
  expect(
    readInlineHistory([
      { ...root(), user: { login: 'human', type: 'User' } },
      { ...root(11), in_reply_to_id: 10 },
    ]),
  ).toEqual([]);
});
it('行コメントの対象パス・元の行・コミットが不一致なら投稿しない', () => {
  for (const comment of [
    { ...root(), path: 'other.ts' },
    { ...root(), original_line: 99 },
    { ...root(), original_commit_id: head },
  ]) {
    expect(() => readInlineHistory([comment])).toThrow();
  }
});

it('過去30件と今回の途中投稿を区別し、概要失敗後も再試行できる', async () => {
  const f = fixture();
  f.inline.push(...Array.from({ length: 30 }, (_, i) => root(i + 1)));
  const priorFindings = readInlineHistory(f.inline);
  const result = {
    ...review,
    findings: [{ ...finding, condition: '新しい条件' }],
    checks: priorFindings.map((p) => ({ id: p.id, status: 'fixed', evidence: '根拠' })),
  };
  f.summaryFailure(true);
  await expect(publish(f.api, { ...metadata, priorFindings }, result)).rejects.toThrow(
    '概要投稿失敗',
  );
  f.summaryFailure(false);
  expect(await publish(f.api, { ...metadata, priorFindings }, result)).toBe(true);
  expect(f.writes.filter((w) => w.path === 'pulls/7/reviews')).toHaveLength(1);
  expect(f.writes.filter((w) => w.path.endsWith('/replies'))).toHaveLength(30);
  expect(f.issues).toHaveLength(1);
});

it('確認対象が実際に31件なら履歴上限を維持する', () => {
  expect(() =>
    reviewHistory(
      [],
      Array.from({ length: 31 }, (_, i) => root(i + 1)),
      head,
      base,
    ),
  ).toThrow('修正確認対象が30件を超えました');
});

it.each([
  { label: '発生条件', findings: [{ ...finding, condition: '別の条件' }] },
  { label: '影響', findings: [{ ...finding, impact: '別の影響' }] },
  { label: '修正方針', findings: [{ ...finding, fix: '別の修正' }] },
  { label: '優先度', findings: [{ ...finding, priority: 'P1' as const }] },
  { label: 'ファイル', findings: [{ ...finding, path: 'other.ts' }] },
  { label: '行番号', findings: [{ ...finding, line: 5 }] },
  { label: '指摘の削除', findings: [] },
  { label: '指摘の追加', findings: [finding, { ...finding, condition: '追加条件' }] },
])('再生成で$labelが変わったら追加投稿せず未完了で止める', async ({ findings }) => {
  const f = fixture();
  const target = { ...metadata, lines: { 'app.ts': [4, 5], 'other.ts': [4] } };
  f.summaryFailure(true);
  await expect(publish(f.api, target, review)).rejects.toThrow('概要投稿失敗');
  f.summaryFailure(false);
  const before = structuredClone(f.writes);
  await expect(publish(f.api, target, { ...review, findings })).rejects.toThrow(
    '投稿済みの指摘と再生成結果が一致しません',
  );
  expect(f.writes).toEqual(before);
  expect(f.issues).toEqual([]);
});

it('再生成で指摘の順番だけが変わった場合は投稿済みスレッドを再利用する', async () => {
  const f = fixture();
  const findings = [finding, { ...finding, condition: '追加条件' }];
  f.summaryFailure(true);
  await expect(publish(f.api, metadata, { ...review, findings })).rejects.toThrow('概要投稿失敗');
  f.summaryFailure(false);
  expect(await publish(f.api, metadata, { ...review, findings: [...findings].reverse() })).toBe(
    true,
  );
  expect(f.writes.filter((w) => w.path === 'pulls/7/reviews')).toHaveLength(1);
  expect(f.issues).toHaveLength(1);
});
