import { REPOSITORY, MARKER, revisionMarker, eligible } from './policy.ts';
import type { PullRequest } from './policy.ts';

export interface InlineCommentInput {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}
export type ApiBody =
  | { body: string }
  | {
      body: string;
      commit_id: string;
      event: 'COMMENT';
      comments: InlineCommentInput[];
    };
export type Api = <T>(path: string, method?: string, body?: ApiBody) => Promise<T>;
export function githubApi(token: string): Api {
  if (!token) throw new Error('GitHub認証がありません');
  return async <T>(path: string, method = 'GET', body?: ApiBody): Promise<T> => {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
    return (await response.json()) as T;
  };
}
export interface Run {
  event: string;
  conclusion: string;
  path: string;
  head_sha: string;
  repository: { id: number };
  head_repository: { id: number };
  pull_requests: { number: number; head: { sha: string }; base: { sha: string } }[];
}
export interface Comment {
  id: number;
  body: string;
  user: { login: string; type: string };
}
export interface ReviewComment extends Comment {
  path: string;
  line: number | null;
  original_line: number | null;
  commit_id: string;
  original_commit_id: string;
  in_reply_to_id?: number;
}
async function pages<T>(api: Api, path: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api<T[]>(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('コメント応答が不正です');
    result.push(...batch);
    if (batch.length < 100) return result;
  }
  throw new Error('コメント取得上限を超えました');
}
export function comments(api: Api, number: number): Promise<Comment[]> {
  return pages(api, `issues/${number}/comments`);
}
export function reviewComments(api: Api, number: number): Promise<ReviewComment[]> {
  return pages(api, `pulls/${number}/comments`);
}
export function ownComment(c: Comment): boolean {
  return (
    c.user?.login === 'github-actions[bot]' && c.user.type === 'Bot' && c.body.startsWith(MARKER)
  );
}
export async function target(api: Api, runId: number): Promise<PullRequest | null> {
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('実行IDが不正です');
  const run = await api<Run>(`actions/runs/${runId}`);
  if (
    run.event !== 'pull_request' ||
    run.conclusion !== 'success' ||
    run.path !== '.github/workflows/docs.yml' ||
    run.repository?.id !== 1426899426 ||
    run.head_repository?.id !== 1426899426 ||
    run.pull_requests?.length !== 1
  )
    return null;
  const number = run.pull_requests[0].number;
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const pr = await api<PullRequest>(`pulls/${number}`);
  if (!eligible(pr) || pr.number !== number) return null;
  const tested = run.pull_requests[0];
  if (tested.head?.sha !== pr.head.sha || tested.base?.sha !== pr.base.sha) return null;
  if (run.head_sha !== pr.head.sha) {
    if (!/^[a-f0-9]{40}$/.test(run.head_sha)) return null;
    const commit = await api<{ parents: { sha: string }[] }>(`git/commits/${run.head_sha}`);
    // PRの仮想mergeコミットを検査したCIにも対応する。
    if (
      commit.parents.length !== 2 ||
      commit.parents[0].sha !== pr.base.sha ||
      commit.parents[1].sha !== pr.head.sha
    )
      return null;
  }
  const prior = await comments(api, pr.number);
  if (prior.some((c) => ownComment(c) && c.body.includes(revisionMarker(pr.head.sha, pr.base.sha))))
    return null;
  return pr;
}
