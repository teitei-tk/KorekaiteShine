import { appendFileSync } from 'node:fs';
import {
  operationMarker,
  generationMarker,
  readArtifact,
  validateArtifact,
  type ReviewArtifact,
} from './artifact.ts';
import { loadSnapshot, snapshotRevision, normalizeSnapshot, type Snapshot } from './snapshot.ts';
import { githubApi, ownComment, type Api, type ReviewComment } from './github.ts';
import { eligible, type PullRequest } from './policy.ts';
import { writeStatusReport } from './status-report.ts';

export function recognizeOperations(artifact: ReviewArtifact, current: Snapshot): Set<string> {
  const issueIds = new Set<number>(),
    inlineIds = new Set<number>(),
    done = new Set<string>();
  for (const op of artifact.operations) {
    const found = [
      ...current.issues.map((c) => ({ c, inline: false })),
      ...current.inline.map((c) => ({ c, inline: true })),
    ].filter(({ c }) => c.body.includes(operationMarker(op.id)));
    if (found.length > 1) throw new Error('同じ投稿操作が重複しています');
    if (!found.length) continue;
    const { c, inline } = found[0];
    const line = c as ReviewComment;
    if (
      !ownComment(c) ||
      c.body !== op.body ||
      (op.kind === 'finding'
        ? !inline ||
          !!line.in_reply_to_id ||
          line.path !== op.path ||
          line.original_line !== op.line ||
          line.original_commit_id !== artifact.metadata.head
        : op.replyTo
          ? !inline || line.in_reply_to_id !== op.replyTo
          : inline)
    )
      throw new Error('操作マーカーと投稿本文・対象が一致しません');
    done.add(op.id);
    (inline ? inlineIds : issueIds).add(c.id);
  }
  const threads = current.threads.filter((t) => {
    if (!inlineIds.has(t.root)) return true;
    if (
      t.resolved ||
      current.inline.some((c) => c.in_reply_to_id === t.root && !inlineIds.has(c.id))
    )
      throw new Error('自分の新規スレッドに外部変更があります');
    return false;
  });
  const external = normalizeSnapshot({
    issues: current.issues.filter((c) => !issueIds.has(c.id)),
    inline: current.inline.filter((c) => !inlineIds.has(c.id)),
    threads,
  });
  if (snapshotRevision(external) !== artifact.historyRevision)
    throw new Error('生成後に履歴が改訂されました');
  return done;
}
export async function publishArtifact(
  api: Api,
  input: ReviewArtifact,
): Promise<'REVIEW_COMPLETE' | 'ALREADY_COMPLETE' | 'TARGET_CHANGED'> {
  const artifact = validateArtifact(input, input.origin),
    m = artifact.metadata;
  let wrote = false;
  for (const op of artifact.operations) {
    const pr = await api<PullRequest>(`pulls/${m.number}`);
    if (!eligible(pr) || pr.number !== m.number || pr.head.sha !== m.head || pr.base.sha !== m.base)
      return 'TARGET_CHANGED';
    const current = await loadSnapshot(api, m.number);
    const done = recognizeOperations(artifact, current);
    // 別生成の同じ対象への途中投稿は、新規生成の再開として扱わない。
    for (const c of [...current.issues, ...current.inline])
      if (
        ownComment(c) &&
        /<!-- generation:v2:\d+:\d+:/.test(c.body) &&
        c.body.includes(`:${m.head}:${m.base} -->`) &&
        !c.body.includes(generationMarker(m, artifact.origin))
      )
        throw new Error('同じ対象に別生成の投稿があります');
    if (done.has(op.id)) continue;
    if (op.kind === 'finding')
      await api(`pulls/${m.number}/comments`, 'POST', {
        body: op.body,
        commit_id: m.head,
        path: op.path!,
        line: op.line!,
        side: 'RIGHT',
      });
    else
      await api(
        op.replyTo
          ? `pulls/${m.number}/comments/${op.replyTo}/replies`
          : `issues/${m.number}/comments`,
        'POST',
        { body: op.body },
      );
    wrote = true;
  }
  return wrote ? 'REVIEW_COMPLETE' : 'ALREADY_COMPLETE';
}
if (import.meta.main) {
  try {
    const origin = {
      run: process.env.GITHUB_RUN_ID!,
      attempt: process.env.GENERATION_ATTEMPT!,
      sha: process.env.GITHUB_SHA!,
    };
    const artifact = readArtifact(process.env.REVIEW_DIRECTORY!, origin),
      m = artifact.metadata;
    if (
      m.number !== Number(process.env.PR_NUMBER) ||
      m.head !== process.env.PR_HEAD ||
      m.base !== process.env.PR_BASE
    )
      throw new Error('投稿対象不一致');
    const result = await publishArtifact(githubApi(process.env.GH_TOKEN ?? ''), artifact);
    writeStatusReport(
      process.env,
      result === 'TARGET_CHANGED' ? 'neutral' : 'success',
      'publish',
      result,
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `投稿結果: ${result}。対象 ${m.head} / ${m.base}\n`,
      );
  } catch {
    writeStatusReport(process.env, 'failure', 'publish', 'PUBLISH_FAILED');
    console.error('投稿未完了です。手動削除後は同じArtifactを再試行しないでください。');
    process.exitCode = 1;
  }
}
