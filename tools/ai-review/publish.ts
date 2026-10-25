import { reviewHistory, readInlineHistory, historyMarker } from './history.ts';
import { REPOSITORY, safe, MARKER } from './policy.ts';
import { readFileSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubApi, comments, reviewComments, ownComment } from './github.ts';
import type { Api } from './github.ts';
import { eligible, validReview, renderReview, revisionMarker } from './policy.ts';
import type { PullRequest, ReviewInput, Finding } from './policy.ts';
import type { Material } from './material.ts';

function findingKey(finding: Finding): string {
  return JSON.stringify([
    finding.priority,
    finding.path,
    finding.line,
    finding.condition,
    finding.impact,
    finding.fix,
  ]);
}

export async function publish(
  api: Api,
  metadata: Material,
  value: ReviewInput | null,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(metadata.number) ||
    metadata.number < 1 ||
    !/^[a-f0-9]{40}$/.test(metadata.head) ||
    !/^[a-f0-9]{40}$/.test(metadata.base)
  )
    throw new Error('対象情報が不正です');
  const review = validReview(value, metadata.lines, metadata.priorFindings);
  const prior = (await comments(api, metadata.number)).filter(ownComment);
  if (prior.some((c) => c.body.includes(revisionMarker(metadata.head, metadata.base))))
    return false;
  const inline = await reviewComments(api, metadata.number);
  const history = reviewHistory(prior, inline, metadata.head, metadata.base);
  if (JSON.stringify(history) !== JSON.stringify(metadata.priorFindings ?? []))
    throw new Error('レビュー中に指摘履歴が変わりました');
  const current = async () => {
    const pr = await api<PullRequest>(`pulls/${metadata.number}`);
    return (
      eligible(pr) &&
      pr.number === metadata.number &&
      pr.head.sha === metadata.head &&
      pr.base.sha === metadata.base
    );
  };
  if (!(await current())) return false;
  const postedBatch = readInlineHistory(inline).filter(
    (f) => f.head === metadata.head && f.base === metadata.base,
  );
  if (
    postedBatch.length &&
    JSON.stringify(postedBatch.map(findingKey).sort()) !==
      JSON.stringify(review.findings.map(findingKey).sort())
  )
    throw new Error('投稿済みの指摘と再生成結果が一致しません。未完了として停止します');
  if (review.findings.length && postedBatch.length === 0) {
    await api(`pulls/${metadata.number}/reviews`, 'POST', {
      body: `${MARKER}\n対象: ${metadata.head} / base: ${metadata.base}\n指摘は該当行のスレッドに記載しています。`,
      commit_id: metadata.head,
      event: 'COMMENT',
      comments: review.findings.map((f) => ({
        path: f.path,
        line: f.line,
        side: 'RIGHT',
        body: [
          renderReview({ ...review, findings: [f], checks: [] }, metadata.head, metadata.base),
          historyMarker([f]),
        ].join('\n\n'),
      })),
    });
  }
  for (const check of review.checks ?? []) {
    const original = history.find((f) => f.id === check.id)!;
    const marker = `<!-- followup:${check.id}:${metadata.head}:${metadata.base} -->`;
    const posted = original.replyTo
      ? inline.some(
          (c) => ownComment(c) && c.in_reply_to_id === original.replyTo && c.body.includes(marker),
        )
      : prior.some((c) => c.body.includes(marker));
    if (posted) continue;
    if (!(await current())) return false;
    const label = check.status === 'fixed' ? '☑️: 修正を確認しました' : '修正が確認できません';
    const reason =
      check.status === 'unverified'
        ? '確認不能'
        : check.status === 'unfixed'
          ? '未修正'
          : '修正済み';
    const link = original.replyTo
      ? `discussion_r${original.replyTo}`
      : `issuecomment-${check.id.split(':')[0]}`;
    const body = [
      MARKER,
      marker,
      // 旧形式の確認投稿も履歴として読み取れるが、完了マーカーは最後の概要だけに付ける。
      `対象: ${metadata.head} / base: ${metadata.base}`,
      `### ${label}`,
      `[元の指摘](https://github.com/${REPOSITORY}/pull/${metadata.number}#${link}) — ${safe(original.path)}:${original.line}`,
      `${reason}: ${safe(check.evidence)}`,
    ].join('\n\n');
    await api(
      original.replyTo
        ? `pulls/${metadata.number}/comments/${original.replyTo}/replies`
        : `issues/${metadata.number}/comments`,
      'POST',
      { body },
    );
  }
  if (!(await current())) return false;
  const body = [
    renderReview({ ...review, findings: [], checks: [] }, metadata.head, metadata.base),
    '新規指摘は該当行のレビュースレッド、修正確認は元スレッドへの返信を参照してください。',
    historyMarker([]),
  ].join('\n\n');
  if (body.length > 60000) throw new Error('コメントの上限を超えました');
  await api(`issues/${metadata.number}/comments`, 'POST', { body });
  return true;
}
function readJson<T>(path: string, max: number): T {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > max) throw new Error('成果物のサイズまたは形式が不正です');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function readReviewArtifact(
  directory: string,
  expected: Pick<Material, 'number' | 'head' | 'base'>,
) {
  const metadata = readJson<Material>(join(directory, 'metadata.json'), 400_000);
  // artifact内の対象と、準備ジョブで確定した対象の両方を照合する。
  if (
    metadata.number !== expected.number ||
    metadata.head !== expected.head ||
    metadata.base !== expected.base
  )
    throw new Error('成果物の対象が一致しません');
  const review = validReview(
    readJson<ReviewInput>(join(directory, 'result.json'), 30_000),
    metadata.lines,
    metadata.priorFindings,
  );
  return { metadata, review };
}

if (import.meta.main) {
  try {
    const { metadata, review } = readReviewArtifact(process.env.REVIEW_DIRECTORY!, {
      number: Number(process.env.PR_NUMBER),
      head: process.env.PR_HEAD!,
      base: process.env.PR_BASE!,
    });
    if (process.argv[2] === 'validate') {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY!,
        `レビュー結果: ${review.status}、指摘${review.findings.length}件。対象SHA: ${metadata.head}\n`,
      );
    } else {
      const posted = await publish(githubApi(process.env.GH_TOKEN ?? ''), metadata, review);
      console.log(
        posted ? 'レビューコメントを投稿しました' : '対象更新または投稿済みのため投稿しません',
      );
    }
  } catch {
    console.error('レビュー出力の検証または投稿に失敗しました。結果は成功として扱いません。');
    process.exitCode = 1;
  }
}
