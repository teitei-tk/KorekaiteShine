import { ReviewFailure } from './failure.ts';
import { indexSources } from './source-index.ts';
import { planReview } from './partition.ts';
import type { PriorFinding } from './history.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPOSITORY } from './policy.ts';
import type { PullRequest } from './policy.ts';

export function isMaterialPath(path: string): boolean {
  if (
    /(^|\/)(\.env[^/]*|\.codex|\.agents|node_modules|dist|build|coverage|\.git)(\/|$)/i.test(path)
  )
    return false;
  if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|actions\.lock)$/.test(path))
    return false;
  return /\.(md|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|css|html|sql)$/.test(path);
}
export function changedLines(patch: string): number[] {
  let line = 0;
  const result: number[] = [];
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!line) continue;
    if (text.startsWith('+')) {
      result.push(line++);
    } else if (text.startsWith(' ')) {
      line++;
    }
  }
  return result;
}
export interface Material {
  number: number;
  head: string;
  base: string;
  lines: Record<string, number[]>;
  priorFindings?: PriorFinding[];
  ancestor?: string;
  partitionVersion?: 1;
  title?: string;
  body?: string | null;
}
export function collect(
  pr: PullRequest,
  directory: string,
  priorFindings: PriorFinding[] = [],
): Material {
  const bare = mkdtempSync(join(directory, 'git-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-C', bare, ...args],
      {
        encoding: 'utf8',
        maxBuffer: 2_000_000,
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          HOME: bare,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_LFS_SKIP_SMUDGE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  git('init', '--bare');
  // 公開リポジトリだけを認証情報なしで取得。checkoutやPR内のコード実行はしない。
  git(
    'fetch',
    '--no-tags',
    '--depth=200',
    `https://github.com/${REPOSITORY}.git`,
    pr.base.sha,
    pr.head.sha,
  );
  return collectFromGit(pr, directory, git, priorFindings);
}

export function collectFromGit(
  pr: PullRequest,
  directory: string,
  git: (...args: string[]) => string,
  priorFindings: PriorFinding[] = [],
): Material {
  const ancestor = git('merge-base', pr.base.sha, pr.head.sha).trim();
  if (!/^[a-f0-9]{40}$/.test(ancestor)) throw new Error('比較元を確定できません');
  const paths = git('diff', '--name-only', '-z', '--no-renames', ancestor, pr.head.sha)
    .split('\0')
    .filter(Boolean);
  if (paths.length > 5000) throw new ReviewFailure('BUDGET_EXCEEDED', '変更一覧の上限を超えました');
  const lines: Record<string, number[]> = Object.create(null);
  const patches = paths.filter(isMaterialPath).map((path) => {
    const patch = git(
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--unified=3',
      ancestor,
      pr.head.sha,
      '--',
      path,
    );
    lines[path] = changedLines(patch);
    return { path, patch };
  });
  const metadata: Material = {
    number: pr.number,
    head: pr.head.sha,
    base: pr.base.sha,
    ancestor,
    lines,
    priorFindings,
    partitionVersion: 1,
    title: pr.title,
    body: pr.body,
  };
  if (Buffer.byteLength(JSON.stringify(metadata)) > 400_000)
    throw new ReviewFailure('BUDGET_EXCEEDED', '変更行と指摘履歴の情報が400KBを超えました');
  const index = indexSources(git, [ancestor, pr.base.sha, pr.head.sha]);
  index.excluded = [...new Set([...index.excluded, ...paths.filter((p) => !isMaterialPath(p))])];
  const plan = planReview(metadata, index, patches);
  writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify(metadata));
  return metadata;
}
