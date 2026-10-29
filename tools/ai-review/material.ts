import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPOSITORY, type PullRequest } from './policy.ts';
import { reviewHistory } from './history.ts';
import { validateMetadata, type Metadata } from './artifact.ts';
import { type Snapshot } from './snapshot.ts';
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

export type Material = Metadata;
export function collect(
  pr: PullRequest,
  directory: string,
  history: Snapshot,
  sourceRun: string,
): Metadata {
  const repository = join(directory, 'repository');
  mkdirSync(repository, { recursive: true });
  const git = (...args: string[]) => {
    const output = join(directory, 'git-output');
    const fd = openSync(output, 'w');
    try {
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-C', repository, ...args],
        {
          timeout: 120000,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_LFS_SKIP_SMUDGE: '1',
          },
          stdio: ['ignore', fd, 'ignore'],
        },
      );
      return readFileSync(output, 'utf8');
    } finally {
      closeSync(fd);
      rmSync(output, { force: true });
    }
  };
  git('init');
  git('fetch', '--no-tags', `https://github.com/${REPOSITORY}.git`, pr.base.sha, pr.head.sha);
  git('checkout', '--detach', '--force', pr.head.sha);
  return collectFromGit(pr, directory, git, history, sourceRun);
}
export function collectFromGit(
  pr: PullRequest,
  directory: string,
  git: (...args: string[]) => string,
  history: Snapshot,
  sourceRun: string,
): Metadata {
  const ancestor = git('merge-base', pr.base.sha, pr.head.sha).trim();
  if (!/^[a-f0-9]{40}$/.test(ancestor)) throw new Error('比較元を確定できません');
  const paths = git('diff', '--name-only', '-z', '--no-renames', ancestor, pr.head.sha)
    .split('\0')
    .filter(Boolean);
  const lines: Record<string, number[]> = Object.create(null);
  for (const path of paths)
    lines[path] = changedLines(
      git(
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--unified=3',
        ancestor,
        pr.head.sha,
        '--',
        path,
      ),
    );
  const metadata = validateMetadata({
    version: 2,
    repository: REPOSITORY,
    number: pr.number,
    head: pr.head.sha,
    base: pr.base.sha,
    sourceRun,
    lines,
    history,
  });
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify(metadata));
  writeFileSync(join(directory, 'history.json'), JSON.stringify(history));
  writeFileSync(
    join(directory, 'request.json'),
    JSON.stringify({
      number: pr.number,
      title: pr.title ?? '',
      body: pr.body ?? '',
      head: pr.head.sha,
      base: pr.base.sha,
      ancestor,
      changedLines: lines,
      priorFindings: reviewHistory(history.issues, history.inline, pr.head.sha, pr.base.sha),
      historyFile: '/opt/ai-review/context/history.json',
    }),
  );
  return metadata;
}
