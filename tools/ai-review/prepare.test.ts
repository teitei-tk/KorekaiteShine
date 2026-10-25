import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReview } from './prepare.ts';
import { collectFromGit } from './material.ts';
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
  if (path === 'pulls/7') return pr as T;
  if (path.includes('/comments?')) return [] as T;
  throw new Error('Unexpected fixture path');
};
it.each(['collection-limit', 'unresolved', 'large-input', 'external-error', 'success', 'skip'])(
  '準備処理のActions概要と許可判定: %s',
  async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), 'prepare-review-'));
    try {
      const env = {
        AI_REVIEW_MODE: 'review',
        SOURCE_RUN_ID: '1',
        REVIEW_DIRECTORY: directory,
        GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
        GITHUB_OUTPUT: join(directory, 'outputs'),
        GITHUB_RUN_ID: '20',
        GITHUB_RUN_ATTEMPT: '1',
        AI_REVIEW_JOB: 'generate',
        AI_REVIEW_REPORT: join(directory, 'status.json'),
      };
      const files =
        scenario === 'large-input' ? Array.from({ length: 10 }, (_, i) => `f${i}.ts`) : ['app.ts'];
      let collections = 0;
      const collect: typeof collectFromGit = (target, dir, _git, prior) =>
        collectFromGit(
          target,
          dir,
          (...args) => {
            if (scenario === 'external-error') throw new Error('SECRET PR本文 予算 token');
            if (args[0] === 'merge-base') return base;
            if (args[0] === 'diff' && args.includes('--name-only'))
              return (
                scenario === 'collection-limit'
                  ? Array.from({ length: 5001 }, (_, i) => `f${i}.ts`)
                  : files
              ).join('\0');
            if (args[0] === 'diff') return '@@ -1 +1 @@\n-old\n+new\n';
            if (args[0] === 'ls-tree')
              return files
                .map((p, i) => `100644 blob ${i.toString(16).padStart(40, '0')}\t${p}\0`)
                .join('');
            if (args[0] === 'cat-file')
              return scenario === 'unresolved'
                ? 'import "./missing.ts";'
                : `export const a = '${'x'.repeat(scenario === 'large-input' ? 220000 : 1)}';`;
            throw new Error('Unexpected fixture git command');
          },
          prior,
        );
      const execute = () =>
        prepareReview(
          'collect',
          env,
          scenario === 'skip' ? async <T>() => ({ ...run, conclusion: 'failure' }) as T : api,
          (p, d, history) => {
            collections++;
            return collect(p, d, () => '', history);
          },
        );
      if (scenario === 'success' || scenario === 'skip' || scenario === 'large-input') {
        await execute();
        expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toContain(`allowed=${scenario !== 'skip'}`);
        expect(existsSync(env.GITHUB_STEP_SUMMARY)).toBe(false);
        expect(collections).toBe(scenario === 'skip' ? 0 : 1);
      } else {
        await expect(execute()).rejects.toThrow();
        const summary = readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
        expect(summary).toContain('完了0件');
        expect(summary).toContain(`対象: ${scenario === 'large-input' ? 'preflight' : 'collect'}`);
        expect(summary).toContain(
          scenario === 'unresolved'
            ? 'UNRESOLVED_REFERENCE'
            : scenario === 'external-error'
              ? 'COLLECTION_FAILED'
              : 'BUDGET_EXCEEDED',
        );
        expect(summary).not.toContain('SECRET');
        expect(summary).not.toContain('token');
        expect(JSON.parse(readFileSync(env.AI_REVIEW_REPORT, 'utf8'))).toMatchObject({
          run: '20',
          attempt: '1',
          job: 'generate',
          status: 'failure',
          target: scenario === 'large-input' ? 'preflight' : 'collect',
          reason:
            scenario === 'unresolved'
              ? 'UNRESOLVED_REFERENCE'
              : scenario === 'external-error'
                ? 'COLLECTION_FAILED'
                : 'BUDGET_EXCEEDED',
        });
        expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toContain('allowed=false');
        expect(existsSync(join(directory, 'result.json'))).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
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
