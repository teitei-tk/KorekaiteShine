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
it.each([
  'collection-limit',
  'unresolved',
  'preflight-budget',
  'external-error',
  'success',
  'skip',
])('準備処理のActions概要と許可判定: %s', async (scenario) => {
  const directory = mkdtempSync(join(tmpdir(), 'prepare-review-'));
  try {
    const env = {
      AI_REVIEW_MODE: 'review',
      SOURCE_RUN_ID: '1',
      REVIEW_DIRECTORY: directory,
      GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
      GITHUB_OUTPUT: join(directory, 'outputs'),
    };
    const files =
      scenario === 'preflight-budget'
        ? Array.from({ length: 10 }, (_, i) => `f${i}.ts`)
        : ['app.ts'];
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
              : `export const a = '${'x'.repeat(scenario === 'preflight-budget' ? 220000 : 1)}';`;
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
    if (scenario === 'success' || scenario === 'skip') {
      await execute();
      expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toContain(
        `allowed=${scenario === 'success'}`,
      );
      expect(existsSync(env.GITHUB_STEP_SUMMARY)).toBe(false);
      expect(collections).toBe(scenario === 'success' ? 1 : 0);
    } else {
      await expect(execute()).rejects.toThrow();
      const summary = readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
      expect(summary).toContain('完了0件');
      expect(summary).toContain(
        `対象: ${scenario === 'preflight-budget' ? 'preflight' : 'collect'}`,
      );
      expect(summary).toContain(
        scenario === 'unresolved'
          ? 'UNRESOLVED_REFERENCE'
          : scenario === 'external-error'
            ? 'COLLECTION_FAILED'
            : 'BUDGET_EXCEEDED',
      );
      expect(summary).not.toContain('SECRET');
      expect(summary).not.toContain('token');
      expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toContain('allowed=false');
      expect(existsSync(join(directory, 'result.json'))).toBe(false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
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
