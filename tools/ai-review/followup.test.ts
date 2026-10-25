import { expect, it } from 'vitest';
import { latestFollowupStatus } from './followup.ts';
import type { Comment, ReviewComment } from './github.ts';
import type { PriorFinding } from './history.ts';
import { MARKER } from './policy.ts';
const sha = 'a'.repeat(40);
const original: PriorFinding = {
  id: '10:1',
  head: sha,
  base: sha,
  priority: 'P2',
  path: 'app.ts',
  line: 1,
  condition: '条件',
  impact: '影響',
  fix: '修正',
};
function reply(id: number, findingId = '10:1'): Comment {
  return {
    id,
    user: { id: 41898282, login: 'github-actions[bot]', type: 'Bot' },
    body: `${MARKER}\n<!-- followup:${findingId}:${sha}:${sha} -->\n### ☑️: 修正を確認しました\n修正済み: 確認済み`,
  };
}
it('旧集約コメントへの旧形式返信でも修正済みを読み取る', () => {
  expect(latestFollowupStatus(original, [reply(20)], [])).toBe('fixed');
});
it('最新の判定が読めない場合、さらに古い修正済み通知を流用しない', () => {
  const latest = reply(30);
  latest.body = latest.body.replace('修正済み: 確認済み', '壊れた本文');
  expect(latestFollowupStatus(original, [latest, reply(20)], [])).toBeUndefined();
});
it('別指摘・人間の返信は通知済み判定へ混ぜない', () => {
  const human = reply(30);
  human.user = { login: 'user', type: 'User' };
  expect(latestFollowupStatus(original, [reply(20, '10:2'), human], [])).toBeUndefined();
});
it('同じマーカーでも別スレッドの返信は流用しない', () => {
  const comment: ReviewComment = {
    ...reply(30, 'review:10'),
    in_reply_to_id: 11,
    path: 'app.ts',
    line: 1,
    original_line: 1,
    commit_id: sha,
    original_commit_id: sha,
  };
  expect(
    latestFollowupStatus({ ...original, id: 'review:10', replyTo: 10 }, [], [comment]),
  ).toBeUndefined();
});
it('新しい固定状態マーカーを読み取り、ID順で最新通知を選ぶ', () => {
  const latest = reply(40);
  latest.body += '\n<!-- followup-state:v1:unverified -->';
  expect(latestFollowupStatus(original, [latest, reply(20)], [])).toBe('unverified');
});
