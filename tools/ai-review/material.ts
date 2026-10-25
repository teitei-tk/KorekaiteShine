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
  const ancestor = git('merge-base', pr.base.sha, pr.head.sha).trim();
  if (!/^[a-f0-9]{40}$/.test(ancestor)) throw new Error('比較元を確定できません');
  const paths = git('diff', '--name-only', '-z', '--no-renames', ancestor, pr.head.sha)
    .split('\0')
    .filter(Boolean);
  if (paths.length > 80) throw new Error('変更ファイル数が80件を超えました');
  const lines: Record<string, number[]> = Object.create(null);
  const patches: { path: string; patch: string }[] = [];
  let bytes = 0;
  const reserve = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > 300_000) throw new Error('資料が300KBを超えました。PRを分割してください');
  };
  const excluded = paths.filter((path) => !isMaterialPath(path));
  for (const path of paths.filter(isMaterialPath)) {
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
    reserve(patch);
    lines[path] = changedLines(patch);
    patches.push({ path, patch });
  }
  const files = snapshotFiles(git, [pr.base.sha, pr.head.sha], reserve);
  const metadata = {
    number: pr.number,
    head: pr.head.sha,
    base: pr.base.sha,
    lines,
    priorFindings,
  };
  const bundle = JSON.stringify({
    ...metadata,
    title: pr.title,
    body: pr.body,
    ancestor,
    excluded,
    patches,
    files,
  });
  if (Buffer.byteLength(bundle) > 400_000) throw new Error('JSON資料が400KBを超えました');
  if (Buffer.byteLength(JSON.stringify(metadata)) > 400_000)
    throw new Error('変更行と指摘履歴の情報が400KBを超えました');
  writeFileSync(join(directory, 'material.json'), bundle);
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify(metadata));
  return metadata;
}

export function snapshotFiles(
  git: (...args: string[]) => string,
  revisions: string[],
  reserve: (text: string) => void,
) {
  const files = new Map<string, { revisions: string[]; path: string; content: string }>();
  for (const revision of revisions) {
    for (const entry of git('ls-tree', '-r', '-z', revision).split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
      if (!match || !isMaterialPath(match[3])) continue; // symlink、submoduleは追跡しない
      const key = `${match[2]}:${match[3]}`;
      const existing = files.get(key);
      if (existing) {
        existing.revisions.push(revision);
        continue;
      }
      if (files.size >= 160) throw new Error('資料ファイル数が160件を超えました');
      const content = git('cat-file', 'blob', match[2]);
      if (content.includes('\0')) throw new Error('テキスト対象にバイナリが含まれています');
      reserve(content);
      files.set(key, { revisions: [revision], path: match[3], content });
    }
  }
  return [...files.values()];
}
