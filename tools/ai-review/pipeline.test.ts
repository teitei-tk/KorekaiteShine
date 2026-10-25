import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticate } from './wif.ts';
import { writeReviewArtifact } from './review.ts';
import { readReviewArtifact, publish } from './publish.ts';
import { REPOSITORY, eligible } from './policy.ts';
import type { PullRequest } from './policy.ts';
import type { Api } from './github.ts';

it.each(['success', 'incomplete', 'changed-head', 'wrong-artifact'])(
  'WIF → SDK → ファイル → 検証 → 投稿: %s',
  async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-review-pipeline-'));
    try {
      const head = 'a'.repeat(40),
        base = 'b'.repeat(40);
      const metadata = { number: 8, head, base, lines: { 'app.ts': [1] } };
      const pr: PullRequest = {
        number: 8,
        user: { id: 1324680, type: 'User' },
        state: 'open',
        draft: false,
        head: { sha: head, repo: { id: 1426899426 } },
        base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
      };
      expect(eligible(pr)).toBe(true);
      writeFileSync(join(directory, 'metadata.json'), JSON.stringify(metadata));
      writeFileSync(join(directory, 'prompt.txt'), 'fixture review material');
      const audience = 'https://api.openai.com/v1';
      const jwt =
        'header.' +
        Buffer.from(
          JSON.stringify({
            iss: 'https://token.actions.githubusercontent.com',
            aud: audience,
            repository: REPOSITORY,
            repository_id: '1426899426',
            repository_owner_id: '1324680',
            ref: 'refs/heads/main',
            workflow_ref: `${REPOSITORY}/.github/workflows/ai-review.yml@refs/heads/main`,
            event_name: 'workflow_run',
          }),
        ).toString('base64url') +
        '.signature';
      const token = 'fixture-' + 'x'.repeat(2048);
      const calls: string[] = [],
        masks: string[] = [],
        writes: string[] = [];
      const request: typeof fetch = async (url, init) => {
        calls.push(String(url));
        if (String(url).startsWith('https://oidc.test/')) return Response.json({ value: jwt });
        if (String(url) === 'https://auth.openai.com/oauth/token') {
          expect(JSON.parse(String(init?.body)).subject_token).toBe(jwt);
          return Response.json({
            access_token: token,
            expires_at: Math.floor(Date.now() / 1000) + 300,
          });
        }
        expect(String(url)).toBe('https://api.openai.com/v1/responses');
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
        return Response.json({
          id: 'resp_fixture',
          object: 'response',
          status: scenario === 'incomplete' ? 'incomplete' : 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  annotations: [],
                  text: JSON.stringify({
                    status: 'complete',
                    summary: '検査済み',
                    uncertainties: [],
                    findings: [
                      {
                        priority: 'P2',
                        path: 'app.ts',
                        line: 1,
                        condition: '条件',
                        impact: '影響',
                        fix: '修正',
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        });
      };
      const auth = await authenticate(
        {
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.test/token',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-github',
          OPENAI_WIF_AUDIENCE: audience,
          OPENAI_IDENTITY_PROVIDER_ID: 'idp_fixture',
          OPENAI_SERVICE_ACCOUNT_ID: 'user-fixture',
        },
        'review',
        request,
        (s) => masks.push(s),
      );
      expect(masks).toEqual([jwt, token]);
      const summary = join(directory, 'summary.md');
      const generate = () => writeReviewArtifact(directory, auth.accessToken!, summary, request);
      if (scenario === 'incomplete') {
        await expect(generate()).rejects.toThrow();
        expect(existsSync(join(directory, 'result.json'))).toBe(false);
        return;
      }
      await generate();
      expect(calls).toHaveLength(3);
      for (const file of ['result.json', 'summary.md']) {
        expect(readFileSync(join(directory, file), 'utf8')).not.toContain(token);
        expect(readFileSync(join(directory, file), 'utf8')).not.toContain(jwt);
      }
      if (scenario === 'wrong-artifact') {
        expect(() =>
          readReviewArtifact(directory, { ...metadata, head: 'c'.repeat(40) }),
        ).toThrow();
        return;
      }
      const artifact = readReviewArtifact(directory, metadata);
      const api: Api = async <T>(path: string, method?: string, body?: { body: string }) => {
        if (method) {
          writes.push(JSON.stringify(body));
          return {} as T;
        }
        if (path.startsWith('pulls/') && path.includes('/comments?')) return [] as T;
        if (path.startsWith('issues/')) return [] as T;
        return {
          ...pr,
          head: { ...pr.head, sha: scenario === 'changed-head' ? 'c'.repeat(40) : head },
        } as T;
      };
      expect(await publish(api, artifact.metadata, artifact.review)).toBe(scenario === 'success');
      expect(writes).toHaveLength(scenario === 'success' ? 2 : 0);
      if (writes.length) {
        expect(writes[0]).toContain(head);
        expect(writes[0]).toContain('app.ts:1');
        expect(writes[0]).not.toContain(token);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each(['fixed', 'unfixed', 'unverified', 'missing', 'changed-history'])(
  '過去指摘 → SDK → 成果物 → 修正確認コメント: %s',
  async (status) => {
    const { readHistory, historyMarker } = await import('./history.ts');
    const { renderReview } = await import('./policy.ts');
    const directory = mkdtempSync(join(tmpdir(), 'ai-followup-pipeline-'));
    try {
      const head = 'a'.repeat(40),
        base = 'b'.repeat(40);
      const finding = {
        priority: 'P1' as const,
        path: 'app.ts',
        line: 1,
        condition: '切断',
        impact: '停止',
        fix: '解放',
      };
      const old = {
        id: 9,
        user: { login: 'github-actions[bot]', type: 'Bot' },
        body:
          renderReview(
            { status: 'complete', summary: '元指摘', findings: [finding], uncertainties: [] },
            'c'.repeat(40),
            base,
          ) +
          '\n' +
          historyMarker([finding]),
      };
      const priorFindings = readHistory([old]);
      const metadata = { number: 8, head, base, lines: {}, priorFindings };
      writeFileSync(join(directory, 'metadata.json'), JSON.stringify(metadata));
      writeFileSync(join(directory, 'prompt.txt'), JSON.stringify({ priorFindings }));
      const fetcher: typeof fetch = async (_url, init) => {
        expect(JSON.parse(String(init?.body)).input).toContain('9:1');
        return Response.json({
          id: 'resp_fixture',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  annotations: [],
                  text: JSON.stringify({
                    status: 'complete',
                    summary: '再確認',
                    uncertainties: [],
                    findings: [],
                    checks:
                      status === 'missing'
                        ? []
                        : [
                            {
                              id: '9:1',
                              status: status === 'changed-history' ? 'fixed' : status,
                              evidence: 'app.ts:1を確認。@someone <b>根拠</b>',
                            },
                          ],
                  }),
                },
              ],
            },
          ],
        });
      };
      const generate = () =>
        writeReviewArtifact(directory, 'fixture-token', join(directory, 'summary.md'), fetcher);
      if (status === 'missing') {
        await expect(generate()).rejects.toThrow();
        expect(existsSync(join(directory, 'result.json'))).toBe(false);
        return;
      }
      await generate();
      const artifact = readReviewArtifact(directory, metadata);
      const writes: string[] = [];
      const api: Api = async <T>(path: string, method?: string, body?: { body: string }) => {
        if (method) {
          writes.push((body as { body: string }).body);
          return {} as T;
        }
        if (path.startsWith('pulls/') && path.includes('/comments?')) return [] as T;
        if (path.startsWith('issues/')) return (status === 'changed-history' ? [] : [old]) as T;
        return {
          number: 8,
          user: { id: 1324680, type: 'User' },
          state: 'open',
          draft: false,
          head: { sha: head, repo: { id: 1426899426 } },
          base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
        } as T;
      };
      if (status === 'changed-history') {
        await expect(publish(api, artifact.metadata, artifact.review)).rejects.toThrow();
        expect(writes).toEqual([]);
        return;
      }
      expect(await publish(api, artifact.metadata, artifact.review)).toBe(true);
      expect(writes).toHaveLength(2);
      expect(writes[0]).toContain(
        status === 'fixed' ? '☑️: 修正を確認しました' : '修正が確認できません',
      );
      expect(writes[0]).toContain(
        status === 'unverified' ? '確認不能:' : status === 'unfixed' ? '未修正:' : '修正済み:',
      );
      expect(writes[0]).toContain(head);
      expect(writes[0]).not.toContain('@someone');
      expect(writes[0]).not.toContain('<b>');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('30件の日本語指摘履歴を含む100KB超のmetadataを読み取る', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-history-size-'));
  try {
    const head = 'a'.repeat(40),
      base = 'b'.repeat(40);
    const priorFindings = Array.from({ length: 30 }, (_, index) => ({
      id: `${index + 1}:1`,
      head,
      base,
      priority: 'P1',
      path: 'app.ts',
      line: index + 1,
      condition: '条'.repeat(1000),
      impact: '影'.repeat(1000),
      fix: '修'.repeat(1000),
    }));
    const metadata = { number: 8, head, base, lines: {}, priorFindings };
    const json = JSON.stringify(metadata);
    expect(Buffer.byteLength(json)).toBeGreaterThan(100000);
    writeFileSync(join(directory, 'metadata.json'), json);
    writeFileSync(
      join(directory, 'result.json'),
      JSON.stringify({
        status: 'complete',
        summary: '確認',
        findings: [],
        uncertainties: [],
        checks: priorFindings.map((f) => ({
          id: f.id,
          status: 'unverified',
          evidence: '資料不足',
        })),
      }),
    );
    expect(readReviewArtifact(directory, metadata).metadata.priorFindings).toHaveLength(30);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
