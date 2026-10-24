import { readFileSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubApi, comments, ownComment } from './github.ts';
import type { Api } from './github.ts';
import { eligible, validReview, renderReview, revisionMarker } from './policy.ts';
import type { PullRequest } from './policy.ts';
import type { Material } from './material.ts';

export async function publish(api: Api, metadata: Material, value: unknown): Promise<boolean> {
  if (
    !Number.isSafeInteger(metadata.number) ||
    metadata.number < 1 ||
    !/^[a-f0-9]{40}$/.test(metadata.head) ||
    !/^[a-f0-9]{40}$/.test(metadata.base)
  )
    throw new Error('対象情報が不正です');
  const review = validReview(value, metadata.lines);
  const prior = (await comments(api, metadata.number)).filter(ownComment);
  if (prior.some((c) => c.body.includes(revisionMarker(metadata.head, metadata.base))))
    return false;
  const pr = await api<PullRequest>(`pulls/${metadata.number}`);
  if (
    !eligible(pr) ||
    pr.number !== metadata.number ||
    pr.head.sha !== metadata.head ||
    pr.base.sha !== metadata.base
  )
    return false;
  const body = renderReview(review, metadata.head, metadata.base);
  if (prior.length) await api(`issues/comments/${prior[0].id}`, 'PATCH', { body });
  else await api(`issues/${metadata.number}/comments`, 'POST', { body });
  return true;
}
function readJson(path: string, max: number): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > max) throw new Error('成果物のサイズまたは形式が不正です');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function readReviewArtifact(
  directory: string,
  expected: Pick<Material, 'number' | 'head' | 'base'>,
) {
  const metadata = readJson(join(directory, 'metadata.json'), 100_000) as Material;
  // artifact内の対象と、準備ジョブで確定した対象の両方を照合する。
  if (
    metadata.number !== expected.number ||
    metadata.head !== expected.head ||
    metadata.base !== expected.base
  )
    throw new Error('成果物の対象が一致しません');
  const review = validReview(readJson(join(directory, 'result.json'), 30_000), metadata.lines);
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
        posted ? 'レビューコメントを更新しました' : '対象更新または投稿済みのため投稿しません',
      );
    }
  } catch {
    console.error('レビュー出力の検証または投稿に失敗しました。結果は成功として扱いません。');
    process.exitCode = 1;
  }
}
