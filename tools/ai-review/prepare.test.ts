import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReview } from './prepare.ts';
import type { Api } from './github.ts';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const pr = {
  number: 7,
  user: { id: 1324680, type: 'User' },
  state: 'open',
  draft: false,
  head: { sha: head, repo: { id: 1426899426 } },
  base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
};
const run = {
  event: 'pull_request',
  conclusion: 'success',
  path: '.github/workflows/docs.yml',
  head_sha: head,
  repository: { id: 1426899426 },
  head_repository: { id: 1426899426 },
  pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }],
};
const api: Api = async <T>(path: string) => {
  if (path === 'actions/runs/1') return run as T;
  if (path === 'graphql')
    return {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    } as T;
  if (path === 'pulls/7') return pr as T;
  if (path.includes('/comments?')) return [] as T;
  throw new Error('Unexpected fixture path');
};
it('CLI失敗は非ゼロ終了し、生成器に到達しなくても概要を記録する', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const directory = mkdtempSync(join(tmpdir(), 'prepare-cli-'));
  try {
    const summary = join(directory, 'summary.md');
    const output = join(directory, 'output');
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./prepare.ts', import.meta.url)), 'collect'],
      {
        env: {
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_OUTPUT: output,
          SOURCE_RUN_ID: '1',
          AI_REVIEW_MODE: 'review',
        },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(child.status).toBe(1);
    expect(readFileSync(summary, 'utf8')).toContain('対象: gate、理由: AUTH_FAILED');
    expect(readFileSync(output, 'utf8')).toBe('allowed=false\n');
    expect(child.stderr).toContain('AUTH_FAILED');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it.each(['same', 'old-head', 'old-base', 'human', 'ineligible'])(
  '準備段階の投稿済み判定は対象と投稿者を照合する: %s',
  async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), 'prepare-completed-'));
    try {
      const env = {
        SOURCE_RUN_ID: '1',
        GITHUB_RUN_ID: '20',
        GITHUB_RUN_ATTEMPT: '2',
        AI_REVIEW_JOB: 'gate',
        AI_REVIEW_REPORT: join(directory, 'status.json'),
        GITHUB_OUTPUT: join(directory, 'output'),
      };
      const client: Api = async <T>(path: string) => {
        if (path === 'pulls/7' && scenario === 'ineligible')
          return { ...pr, base: { ...pr.base, ref: 'other' } } as T;
        if (path.startsWith('issues/7/comments?'))
          return [
            {
              id: 1,
              user: {
                login: scenario === 'human' ? 'owner' : 'github-actions[bot]',
                type: scenario === 'human' ? 'User' : 'Bot',
              },
              body: `<!-- korekaite-ai-review -->\n<!-- revision:${scenario === 'old-head' ? 'c'.repeat(40) : head}:${scenario === 'old-base' ? 'c'.repeat(40) : base} -->`,
            },
          ] as T;
        return api<T>(path);
      };
      await prepareReview('gate', env, client);
      if (scenario === 'same' || scenario === 'ineligible') {
        expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('allowed=false\n');
        expect(JSON.parse(readFileSync(env.AI_REVIEW_REPORT, 'utf8'))).toMatchObject({
          status: scenario === 'same' ? 'success' : 'neutral',
          reason: scenario === 'same' ? 'ALREADY_COMPLETE' : 'SKIPPED',
        });
      } else {
        expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toContain('allowed=true');
        expect(existsSync(env.AI_REVIEW_REPORT)).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
