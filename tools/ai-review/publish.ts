import { readHistory, historyMarker } from './history.ts';
import { REPOSITORY, safe } from './policy.ts';
import { readFileSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubApi, comments, ownComment } from './github.ts';
import type { Api } from './github.ts';
import { eligible, validReview, renderReview, revisionMarker } from './policy.ts';
import type { PullRequest, ReviewInput } from './policy.ts';
import type { Material } from './material.ts';

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
  const history = readHistory(prior);
  if (JSON.stringify(history) !== JSON.stringify(metadata.priorFindings ?? []))
    throw new Error('レビュー中に指摘履歴が変わりました');
  const pr = await api<PullRequest>(`pulls/${metadata.number}`);
  if (
    !eligible(pr) ||
    pr.number !== metadata.number ||
    pr.head.sha !== metadata.head ||
    pr.base.sha !== metadata.base
  )
    return false;
  const followups = (review.checks ?? []).map((check) => {
    const original = history.find((f) => f.id === check.id)!;
    const label = check.status === 'fixed' ? '☑️: 修正を確認しました' : '修正が確認できません';
    const reason =
      check.status === 'unverified'
        ? '確認不能'
        : check.status === 'unfixed'
          ? '未修正'
          : '修正済み';
    return `### 指摘 ${check.id}: ${label}\n\n[元の指摘](https://github.com/${REPOSITORY}/pull/${metadata.number}#issuecomment-${check.id.split(':')[0]}) — ${safe(original.path)}:${original.line}\n\n${reason}: ${safe(check.evidence)}`;
  });
  const body = [
    renderReview(review, metadata.head, metadata.base),
    ...followups,
    historyMarker(review.findings),
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
