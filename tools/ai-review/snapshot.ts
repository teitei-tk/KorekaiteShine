import { isJsonObject } from './json.ts';
import type { JsonInput } from './json.ts';
import { createHash } from 'node:crypto';
import { comments, reviewComments } from './github.ts';
import type { Api, Comment, ReviewComment } from './github.ts';
export type Thread = { id: string; root: number; resolved: boolean };
export type Snapshot = { issues: Comment[]; inline: ReviewComment[]; threads: Thread[] };
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const idValid = (id: JsonInput): id is number =>
  typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
function comment(value: JsonInput): Comment {
  if (
    !isJsonObject(value) ||
    !idValid(value.id) ||
    typeof value.body !== 'string' ||
    !isJsonObject(value.user) ||
    typeof value.user.login !== 'string' ||
    typeof value.user.type !== 'string' ||
    (value.user.id !== undefined && !idValid(value.user.id)) ||
    (value.updated_at !== undefined && typeof value.updated_at !== 'string')
  ) {
    throw new Error('履歴コメントが不正です');
  }
  return {
    id: value.id,
    body: value.body,
    ...(value.updated_at === undefined ? {} : { updated_at: value.updated_at }),
    user: {
      login: value.user.login,
      type: value.user.type,
      ...(value.user.id === undefined ? {} : { id: value.user.id }),
    },
  };
}
export function normalizeSnapshot(input: JsonInput): Snapshot {
  if (
    !isJsonObject(input) ||
    !Array.isArray(input.issues) ||
    !Array.isArray(input.inline) ||
    !Array.isArray(input.threads)
  ) {
    throw new Error('履歴スナップショットが不正です');
  }
  const issues = input.issues.map(comment).toSorted((a, b) => a.id - b.id);
  const inline = input.inline
    .map((c): ReviewComment => {
      if (!isJsonObject(c)) {
        throw new Error('履歴コメントが不正です');
      }
      const base = comment(c);
      if (
        typeof c.path !== 'string' ||
        typeof c.commit_id !== 'string' ||
        !/^[a-f0-9]{40}$/u.test(c.commit_id) ||
        typeof c.original_commit_id !== 'string' ||
        !/^[a-f0-9]{40}$/u.test(c.original_commit_id) ||
        !(c.line === null || idValid(c.line)) ||
        !(c.original_line === null || idValid(c.original_line)) ||
        (c.in_reply_to_id !== undefined && !idValid(c.in_reply_to_id))
      ) {
        throw new Error('行コメントが不正です');
      }
      return {
        ...base,
        path: c.path,
        line: c.line,
        original_line: c.original_line,
        commit_id: c.commit_id,
        original_commit_id: c.original_commit_id,
        ...(c.in_reply_to_id === undefined ? {} : { in_reply_to_id: c.in_reply_to_id }),
      };
    })
    .toSorted((a, b) => a.id - b.id);
  const roots = inline.filter((c) => !c.in_reply_to_id).map((c) => c.id);
  const threads = input.threads
    .map((t) => {
      if (
        !isJsonObject(t) ||
        typeof t.id !== 'string' ||
        !t.id ||
        typeof t.root !== 'number' ||
        !roots.includes(t.root) ||
        typeof t.resolved !== 'boolean'
      ) {
        throw new Error('スレッド状態が不正です');
      }
      return { id: t.id, root: t.root, resolved: t.resolved };
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
  if (
    new Set(issues.map((c) => c.id)).size !== issues.length ||
    new Set(inline.map((c) => c.id)).size !== inline.length ||
    new Set(threads.map((t) => t.id)).size !== threads.length ||
    new Set(threads.map((t) => t.root)).size !== roots.length ||
    threads.length !== roots.length ||
    inline.some((c) => c.in_reply_to_id !== undefined && !roots.includes(c.in_reply_to_id))
  ) {
    throw new Error('履歴の関連が欠落・重複しています');
  }
  return { issues, inline, threads };
}
export function snapshotRevision(snapshot: Snapshot): string {
  return digest(JSON.stringify(normalizeSnapshot(snapshot)));
}
type ThreadPage = {
  errors?: object[];
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes: {
            id: string;
            isResolved: boolean;
            comments: { nodes: { databaseId: number }[] };
          }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
  };
};
export async function loadSnapshot(api: Api, number: number): Promise<Snapshot> {
  const [issues, inline] = await Promise.all([comments(api, number), reviewComments(api, number)]);
  const threads: Thread[] = [];
  const seen = new Set<string>();
  const cursorState = { cursor: null as string | null };
  for (;;) {
    const page: ThreadPage = await api('graphql', 'POST', {
      query:
        'query($number:Int!,$cursor:String){repository(owner:"teitei-tk",name:"KorekaiteShine"){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:1){nodes{databaseId}}} pageInfo{hasNextPage endCursor}}}}}',
      variables: { number, cursor: cursorState.cursor },
    });
    const connection = page?.data?.repository?.pullRequest?.reviewThreads;
    if (
      page?.errors?.length ||
      !connection ||
      !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== 'boolean'
    ) {
      throw new Error('Resolve状態を取得できません');
    }
    for (const node of connection.nodes) {
      if (!node || !Array.isArray(node.comments?.nodes) || node.comments.nodes.length !== 1) {
        throw new Error('スレッド元が不明です');
      }
      threads.push({
        id: node.id,
        root: node.comments.nodes[0].databaseId,
        resolved: node.isResolved,
      });
    }
    if (!connection.pageInfo.hasNextPage) {
      break;
    }
    cursorState.cursor = connection.pageInfo.endCursor;
    if (
      typeof cursorState.cursor !== 'string' ||
      !cursorState.cursor ||
      seen.has(cursorState.cursor)
    ) {
      throw new Error('履歴ページが進みません');
    }
    seen.add(cursorState.cursor);
  }
  return normalizeSnapshot({ issues, inline, threads });
}
