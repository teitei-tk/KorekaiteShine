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
      const api: Api = async <T>(path: string, method?: string, body?: unknown) => {
        if (method) {
          writes.push(JSON.stringify(body));
          return {} as T;
        }
        if (path.startsWith('issues/')) return [] as T;
        return {
          ...pr,
          head: { ...pr.head, sha: scenario === 'changed-head' ? 'c'.repeat(40) : head },
        } as T;
      };
      expect(await publish(api, artifact.metadata, artifact.review)).toBe(scenario === 'success');
      expect(writes).toHaveLength(scenario === 'success' ? 1 : 0);
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
