import { ownComment } from './github.ts';
import type { Comment, ReviewComment } from './github.ts';
import type { PriorFinding } from './history.ts';
import type { FixCheck } from './policy.ts';

// SHAや根拠文ではなく、同じ指摘に対する最新の通知状態を比較する。
export function latestFollowupStatus(
  original: PriorFinding,
  issues: Comment[],
  inline: ReviewComment[],
): FixCheck['status'] | undefined {
  const replies = original.replyTo
    ? inline.filter((c) => c.in_reply_to_id === original.replyTo)
    : issues;
  const latest = replies
    .filter((c) => {
      if (!ownComment(c) || !Number.isSafeInteger(c.id)) return false;
      const marker = /^<!-- followup:(.+):([a-f0-9]{40}):([a-f0-9]{40}) -->$/m.exec(c.body);
      return marker?.[1] === original.id;
    })
    .sort((a, b) => b.id - a.id)[0];
  if (!latest) return;
  const state = /^<!-- followup-state:v1:(fixed|unfixed|unverified) -->$/m.exec(latest.body)?.[1];
  if (state === 'fixed' || state === 'unfixed' || state === 'unverified') return state;
  // 投稿済みの旧形式も読めるように、固定見出し・固定ラベルを読む。
  if (/^### ☑️: 修正を確認しました$/m.test(latest.body) && /^修正済み: /m.test(latest.body))
    return 'fixed';
  if (/^### 修正が確認できません$/m.test(latest.body)) {
    if (/^未修正: /m.test(latest.body)) return 'unfixed';
    if (/^確認不能: /m.test(latest.body)) return 'unverified';
  }
}
