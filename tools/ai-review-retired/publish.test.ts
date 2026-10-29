import { expect, it } from 'vitest';
import { publish } from './publish.ts';
import type { Api } from './github.ts';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const metadata = { number: 7, head, base, lines: { 'app.ts': [1] } };
const review = { status: 'complete', summary: '確認済み', uncertainties: [], findings: [] };
it('投稿直前のhead変更では書き込みを行わない', async () => {
  const writes: ({ body: string } | undefined)[] = [];
  const api: Api = async <T>(path: string, method?: string, body?: { body: string }) => {
    if (method) writes.push(body);
    if (path.startsWith('pulls/') && path.includes('/comments?')) return [] as T;
    if (path.startsWith('issues/')) return [] as T;
    return {
      number: 7,
      user: { id: 1324680, type: 'User' },
      state: 'open',
      draft: false,
      head: { sha: 'c'.repeat(40), repo: { id: 1426899426 } },
      base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
    } as T;
  };
  expect(await publish(api, metadata, review)).toBe(false);
  expect(writes).toEqual([]);
});
it('不正な指摘位置はGitHubへ接続する前に拒否する', async () => {
  let calls = 0;
  const api: Api = async <T>() => {
    calls++;
    return {} as T;
  };
  await expect(
    publish(api, metadata, {
      ...review,
      findings: [
        { priority: 'P1', path: 'secret', line: 1, condition: '条件', impact: '影響', fix: '修正' },
      ],
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

it('本人の最新PRには投稿し、他人に変わっていれば投稿しない', async () => {
  for (const author of [1324680, 99]) {
    const writes: { path: string; method: string; body: { body: string } | undefined }[] = [];
    const api: Api = async <T>(path: string, method?: string, body?: { body: string }) => {
      if (method) {
        writes.push({ path, method, body });
        return {} as T;
      }
      if (path.startsWith('pulls/') && path.includes('/comments?')) return [] as T;
      if (path.startsWith('issues/')) return [] as T;
      return {
        number: 7,
        user: { id: author, type: 'User' },
        state: 'open',
        draft: false,
        head: { sha: head, repo: { id: 1426899426 } },
        base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
      } as T;
    };
    expect(await publish(api, metadata, review)).toBe(author === 1324680);
    expect(writes.length).toBe(author === 1324680 ? 1 : 0);
    if (writes.length) {
      expect(writes[0].path).toBe('issues/7/comments');
      expect(writes[0].method).toBe('POST');
      expect((writes[0].body as { body: string }).body).toContain(head);
    }
  }
});

it('同じ対象への再投稿を抑止し、人間のコメントは更新しない', async () => {
  for (const duplicate of [true, false]) {
    const writes: string[] = [];
    const api: Api = async <T>(path: string, method?: string) => {
      if (method) {
        writes.push(`${method} ${path}`);
        return {} as T;
      }
      if (path.startsWith('pulls/') && path.includes('/comments?')) return [] as T;
      if (path.startsWith('issues/'))
        return [
          {
            id: 10,
            user: {
              login: duplicate ? 'github-actions[bot]' : 'someone',
              type: duplicate ? 'Bot' : 'User',
            },
            body: `<!-- korekaite-ai-review -->\n<!-- revision:${head}:${base} -->`,
          },
        ] as T;
      return {
        number: 7,
        user: { id: 1324680, type: 'User' },
        state: 'open',
        draft: false,
        head: { sha: head, repo: { id: 1426899426 } },
        base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
      } as T;
    };
    expect(await publish(api, metadata, review)).toBe(!duplicate);
    expect(writes).toEqual(duplicate ? [] : ['POST issues/7/comments']);
  }
});

it('過去の指摘を保持して修正結果を新規投稿し、再実行は重複しない', async () => {
  const { renderReview } = await import('./policy.ts');
  const { readHistory } = await import('./history.ts');
  const old = {
    id: 10,
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: renderReview(
      {
        ...review,
        status: 'complete',
        findings: [
          {
            priority: 'P1',
            path: 'app.ts',
            line: 1,
            condition: '条件',
            impact: '影響',
            fix: '修正',
          },
        ],
      },
      'c'.repeat(40),
      base,
    ),
  };
  const priorFindings = readHistory([old]);
  const stored = [old];
  const writes: string[] = [];
  const api: Api = async <T>(path: string, method?: string, body?: { body: string }) => {
    if (method) {
      writes.push(method);
      stored.push({ id: 11, user: old.user, body: (body as { body: string }).body });
      return {} as T;
    }
    if (path.startsWith('pulls/') && path.includes('/comments?')) return [] as T;
    if (path.startsWith('issues/')) return stored as T;
    return {
      number: 7,
      user: { id: 1324680, type: 'User' },
      state: 'open',
      draft: false,
      head: { sha: head, repo: { id: 1426899426 } },
      base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
    } as T;
  };
  const result = {
    ...review,
    checks: [{ id: '10:1', status: 'fixed', evidence: 'app.tsの解放処理を確認' }],
  };
  expect(await publish(api, { ...metadata, priorFindings }, result)).toBe(true);
  expect(stored[0]).toEqual(old);
  expect(writes).toEqual(['POST', 'POST']);
  expect(stored[1].body).toContain('☑️: 修正を確認しました');
  expect(stored[1].body).toContain('issuecomment-10');
  expect(stored[1].body).toContain('app.tsの解放処理を確認');
  expect(await publish(api, { ...metadata, priorFindings }, result)).toBe(false);
  expect(writes).toHaveLength(2);
});

it('未完了のレビューではGitHubの読み書きを始めない', async () => {
  let calls = 0;
  const api: Api = async <T>() => {
    calls++;
    return {} as T;
  };
  await expect(
    publish(
      api,
      { number: 1, head: 'a'.repeat(40), base: 'b'.repeat(40), lines: {} },
      { status: 'incomplete', summary: '資料不足', uncertainties: [], findings: [] },
    ),
  ).rejects.toThrow('未完了');
  expect(calls).toBe(0);
});
