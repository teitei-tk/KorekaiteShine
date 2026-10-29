import { expect, it } from 'vitest';
import { createArtifact } from './artifact.ts';
import { publishArtifact } from './publish.ts';
import { type Snapshot } from './snapshot.ts';
import { type Api, type ApiBody } from './github.ts';
import { MARKER, type Review } from './policy.ts';
import { historyMarker } from './history.ts';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  old = 'c'.repeat(40);
const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
const finding = {
  priority: 'P2' as const,
  path: 'a.ts',
  line: 1,
  condition: 'condition',
  impact: 'impact',
  fix: 'fix',
};
function fixture() {
  const snapshot: Snapshot = {
    issues: [],
    inline: [
      {
        id: 1,
        body: `${MARKER}\n<!-- revision:${old}:${base} -->\n${historyMarker([finding])}`,
        user: bot,
        path: 'a.ts',
        line: 1,
        original_line: 1,
        commit_id: old,
        original_commit_id: old,
      },
    ],
    threads: [{ id: 'T1', root: 1, resolved: false }],
  };
  let count = 0;
  let failAfterWrite = false;
  const api: Api = async <T>(path: string, method = 'GET', body?: ApiBody) => {
    if (method === 'POST' && path !== 'graphql') {
      count++;
      const id = 10 + count;
      const text = body && 'body' in body ? body.body : '';
      if (path.endsWith('/replies'))
        snapshot.inline.push({ ...snapshot.inline[0], id, body: text, in_reply_to_id: 1 });
      else if (path.startsWith('issues/')) snapshot.issues.push({ id, body: text, user: bot });
      else {
        snapshot.inline.push({
          ...snapshot.inline[0],
          id,
          body: text,
          commit_id: head,
          original_commit_id: head,
        });
        snapshot.threads.push({ id: `T${id}`, root: id, resolved: false });
      }
      if (failAfterWrite) {
        failAfterWrite = false;
        throw new Error('response lost');
      }
      return { id } as T;
    }
    if (path === 'pulls/7')
      return {
        number: 7,
        user: { id: 1324680, type: 'User' },
        state: 'open',
        draft: false,
        head: { sha: head, repo: { id: 1426899426 } },
        base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
      } as T;
    if (path.startsWith('issues/')) return structuredClone(snapshot.issues) as T;
    if (path.startsWith('pulls/7/comments?')) return structuredClone(snapshot.inline) as T;
    if (path === 'graphql')
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: snapshot.threads.map((t) => ({
                  id: t.id,
                  isResolved: t.resolved,
                  comments: { nodes: [{ databaseId: t.root }] },
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      } as T;
    throw new Error('unexpected path ' + path);
  };
  const metadata = {
    version: 2 as const,
    repository: 'teitei-tk/KorekaiteShine',
    number: 7,
    head,
    base,
    sourceRun: '12',
    lines: { 'a.ts': [1] },
    history: structuredClone(snapshot),
  };
  const review: Review = {
    status: 'complete',
    summary: 'summary',
    uncertainties: [],
    findings: [],
    checks: [{ id: 'review:1', status: 'fixed', evidence: 'fixed in head' }],
  };
  const artifact = createArtifact(metadata, review, { run: '20', attempt: '1', sha: base }, null);
  return {
    api,
    snapshot,
    artifact,
    count: () => count,
    lose: () => {
      failAfterWrite = true;
    },
  };
}
it('返信成功・応答喪失後は同じArtifactの残りだけを投稿する', async () => {
  const f = fixture();
  f.lose();
  await expect(publishArtifact(f.api, f.artifact)).rejects.toThrow('response lost');
  expect(f.count()).toBe(1);
  await publishArtifact(f.api, f.artifact);
  expect(f.count()).toBe(2);
  await publishArtifact(f.api, f.artifact);
  expect(f.count()).toBe(2);
});
it.each(['human', 'edit', 'resolve', 'wrong-body'])('再開前の%s変更を拒否する', async (kind) => {
  const f = fixture();
  f.lose();
  await expect(publishArtifact(f.api, f.artifact)).rejects.toThrow();
  if (kind === 'human')
    f.snapshot.issues.push({
      id: 90,
      body: 'new human reply',
      user: { id: 2, login: 'human', type: 'User' },
    });
  if (kind === 'edit') f.snapshot.inline[0].body += 'edited';
  if (kind === 'resolve') f.snapshot.threads[0].resolved = true;
  if (kind === 'wrong-body') f.snapshot.inline[1].body += 'edited';
  await expect(publishArtifact(f.api, f.artifact)).rejects.toThrow();
  expect(f.count()).toBe(1);
});
it('応答喪失後の手動削除は検知できず再作成される限界を記録する', async () => {
  const f = fixture();
  f.lose();
  await expect(publishArtifact(f.api, f.artifact)).rejects.toThrow();
  f.snapshot.inline.pop();
  await publishArtifact(f.api, f.artifact);
  expect(f.count()).toBe(3);
});
it('新規スレッドの応答喪失も本文・位置照合で再開し、外部返信は除外しない', async () => {
  const f = fixture();
  const artifact = createArtifact(
    f.artifact.metadata,
    {
      ...f.artifact.review,
      findings: [{ ...finding, condition: 'another condition', impact: 'another impact' }],
    },
    f.artifact.origin,
    null,
  );
  f.lose();
  await expect(publishArtifact(f.api, artifact)).rejects.toThrow('response lost');
  await publishArtifact(f.api, artifact);
  expect(f.count()).toBe(3);
  f.snapshot.inline.push({
    ...f.snapshot.inline[1],
    id: 99,
    body: 'human',
    user: { id: 2, login: 'human', type: 'User' },
    in_reply_to_id: 11,
  });
  await expect(publishArtifact(f.api, artifact)).rejects.toThrow();
  expect(f.count()).toBe(3);
});
it('状態不変では返信せず、修正後の再発では未修正返信を作る', () => {
  const f = fixture();
  const unchanged = createArtifact(
    f.artifact.metadata,
    {
      ...f.artifact.review,
      checks: [{ id: 'review:1', status: 'unfixed', evidence: 'still present' }],
    },
    f.artifact.origin,
    null,
  );
  expect(unchanged.operations.map((o) => o.kind)).toEqual(['summary']);
  const history = structuredClone(f.artifact.metadata.history);
  history.inline.push({
    ...history.inline[0],
    id: 2,
    in_reply_to_id: 1,
    body: f.artifact.operations[0].body,
  });
  const recurrence = createArtifact(
    { ...f.artifact.metadata, history },
    { ...f.artifact.review, checks: [{ id: 'review:1', status: 'unfixed', evidence: 'returned' }] },
    { ...f.artifact.origin, run: '21' },
    null,
  );
  expect(recurrence.operations.map((o) => o.kind)).toEqual(['reply', 'summary']);
  expect(recurrence.operations[0].body).toContain('修正が確認できません');
});
it('出力改竄・旧形式・別生成元・確認漏れを拒否する', async () => {
  const { validateArtifact } = await import('./artifact.ts');
  const f = fixture();
  for (const mutate of [
    (v: typeof f.artifact) => {
      v.operations[0].body += 'changed';
    },
    (v: typeof f.artifact) => {
      v.historyRevision = '0'.repeat(64);
    },
    (v: typeof f.artifact) => {
      v.operations = [];
    },
  ]) {
    const v = structuredClone(f.artifact);
    mutate(v);
    expect(() => validateArtifact(v, f.artifact.origin)).toThrow();
  }
  expect(() => validateArtifact(JSON.parse('{"version":1}'), f.artifact.origin)).toThrow();
  expect(() => validateArtifact(f.artifact, { ...f.artifact.origin, attempt: '2' })).toThrow();
  expect(() =>
    createArtifact(
      f.artifact.metadata,
      { ...f.artifact.review, checks: [] },
      f.artifact.origin,
      null,
    ),
  ).toThrow();
});
it('投稿直前に対象が変われば書き込まない', async () => {
  const f = fixture();
  const api: Api = async <T>(path: string, method?: string, body?: ApiBody) =>
    path === 'pulls/7' ? ({ number: 7, state: 'closed' } as T) : f.api<T>(path, method, body);
  await expect(publishArtifact(api, f.artifact)).resolves.toBe('TARGET_CHANGED');
  expect(f.count()).toBe(0);
});
