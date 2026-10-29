import { createHash } from 'node:crypto';
import { comments, reviewComments, type Api, type Comment, type ReviewComment } from './github.ts';
export type Thread = { id: string; root: number; resolved: boolean };
export type Snapshot = { issues: Comment[]; inline: ReviewComment[]; threads: Thread[] };
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const idValid = (id: number) => Number.isSafeInteger(id) && id > 0;
function comment(value: Comment): Comment {
  if (
    !value ||
    !idValid(value.id) ||
    typeof value.body !== 'string' ||
    !value.user ||
    typeof value.user.login !== 'string' ||
    typeof value.user.type !== 'string' ||
    (value.user.id !== undefined && !idValid(value.user.id)) ||
    (value.updated_at !== undefined && typeof value.updated_at !== 'string')
  )
    throw new Error('履歴コメントが不正です');
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
export function normalizeSnapshot(input: Snapshot): Snapshot {
  if (
    !input ||
    !Array.isArray(input.issues) ||
    !Array.isArray(input.inline) ||
    !Array.isArray(input.threads)
  )
    throw new Error('履歴スナップショットが不正です');
  const issues = input.issues.map(comment).sort((a, b) => a.id - b.id);
  const inline = input.inline
    .map((c): ReviewComment => {
      const base = comment(c);
      if (
        typeof c.path !== 'string' ||
        ![c.commit_id, c.original_commit_id].every((x) => /^[a-f0-9]{40}$/.test(x)) ||
        ![c.line, c.original_line].every((x) => x === null || idValid(x)) ||
        (c.in_reply_to_id !== undefined && !idValid(c.in_reply_to_id))
      )
        throw new Error('行コメントが不正です');
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
    .sort((a, b) => a.id - b.id);
  const roots = inline.filter((c) => !c.in_reply_to_id).map((c) => c.id);
  const threads = input.threads
    .map((t) => {
      if (
        !t ||
        typeof t.id !== 'string' ||
        !t.id ||
        !roots.includes(t.root) ||
        typeof t.resolved !== 'boolean'
      )
        throw new Error('スレッド状態が不正です');
      return { id: t.id, root: t.root, resolved: t.resolved };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    new Set(issues.map((c) => c.id)).size !== issues.length ||
    new Set(inline.map((c) => c.id)).size !== inline.length ||
    new Set(threads.map((t) => t.id)).size !== threads.length ||
    new Set(threads.map((t) => t.root)).size !== roots.length ||
    threads.length !== roots.length ||
    inline.some((c) => c.in_reply_to_id && !roots.includes(c.in_reply_to_id))
  )
    throw new Error('履歴の関連が欠落・重複しています');
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
  let cursor: string | null = null;
  for (;;) {
    const page: ThreadPage = await api('graphql', 'POST', {
      query:
        'query($number:Int!,$cursor:String){repository(owner:"teitei-tk",name:"KorekaiteShine"){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:1){nodes{databaseId}}} pageInfo{hasNextPage endCursor}}}}}',
      variables: { number, cursor },
    });
    const connection = page?.data?.repository?.pullRequest?.reviewThreads;
    if (
      page?.errors?.length ||
      !connection ||
      !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== 'boolean'
    )
      throw new Error('Resolve状態を取得できません');
    for (const node of connection.nodes) {
      if (!node || !Array.isArray(node.comments?.nodes) || node.comments.nodes.length !== 1)
        throw new Error('スレッド元が不明です');
      threads.push({
        id: node.id,
        root: node.comments.nodes[0].databaseId,
        resolved: node.isResolved,
      });
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor))
      throw new Error('履歴ページが進みません');
    seen.add(cursor);
  }
  return normalizeSnapshot({ issues, inline, threads });
}
