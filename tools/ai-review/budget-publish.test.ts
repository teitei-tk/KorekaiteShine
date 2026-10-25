import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger, maximumCost } from './budget.ts';
import { readBudgetArtifact, publishBudget, renderBudget } from './budget-publish.ts';
import type { Api, Comment } from './github.ts';
const origin = { run: '10', attempt: '1', sha: 'a'.repeat(40) };
const target = { number: 25, head: 'b'.repeat(40), base: 'c'.repeat(40) };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'budget-publish-'));
  const ledger = new BudgetLedger(
    join(directory, 'budget.json'),
    origin,
    target,
    maximumCost(100) - 1,
  );
  expect(() => ledger.reserve(100, 'd'.repeat(64))).toThrow();
  writeFileSync(join(directory, 'budget-result.json'), JSON.stringify(ledger.snapshot()));
  return {
    directory,
    record: ledger.snapshot(),
    env: {
      GITHUB_RUN_ID: '10',
      GITHUB_RUN_ATTEMPT: '1',
      AI_REVIEW_JOB: 'publish',
      AI_REVIEW_REPORT: join(directory, 'status.json'),
    },
  };
}
it('別試行・対象・金額改ざんを拒否し、固定の予算結果を読む', () => {
  const { directory, record } = fixture();
  expect(readBudgetArtifact(directory, target, origin)).toEqual(record);
  expect(() => readBudgetArtifact(directory, target, { ...origin, attempt: '2' })).toThrow();
  expect(() =>
    readBudgetArtifact(directory, { ...target, head: 'e'.repeat(40) }, origin),
  ).toThrow();
  writeFileSync(
    join(directory, 'budget-result.json'),
    JSON.stringify({ ...record, denied: { ...record.denied, maximum: 0 } }),
  );
  expect(() => readBudgetArtifact(directory, target, origin)).toThrow();
});
it.each(['post', 'duplicate', 'changed', 'failure', 'conflict', 'spoof'])(
  '予算通知と重複・失敗処理: %s',
  async (scenario) => {
    const { record, env } = fixture();
    const writes: string[] = [];
    const prior: Comment[] = [];
    if (['duplicate', 'conflict', 'spoof'].includes(scenario))
      prior.push({
        id: 99,
        body: renderBudget(record) + (scenario === 'conflict' ? 'modified' : ''),
        user: {
          id: scenario === 'spoof' ? 1 : 41898282,
          login: 'github-actions[bot]',
          type: 'Bot',
        },
      });
    const api: Api = async <T>(path: string, method?: string, body?: { body: string }) => {
      if (method) {
        writes.push(path);
        expect(method).toBe('POST');
        expect(body?.body).toContain('PRを分割してください');
        if (scenario === 'failure') throw Error('SECRET');
        return { id: 100 } as T;
      }
      if (path.startsWith('issues/')) return prior as T;
      return {
        number: 25,
        user: { id: 1324680, type: 'User' },
        state: 'open',
        draft: false,
        head: {
          sha: scenario === 'changed' ? 'e'.repeat(40) : target.head,
          repo: { id: 1426899426 },
        },
        base: { sha: target.base, ref: 'main', repo: { id: 1426899426 } },
      } as T;
    };
    if (['failure', 'conflict'].includes(scenario)) {
      await expect(publishBudget(api, record, env)).rejects.toThrow();
      expect(JSON.parse(readFileSync(env.AI_REVIEW_REPORT, 'utf8')).reason).toBe('PUBLISH_FAILED');
    } else {
      await publishBudget(api, record, env);
      expect(JSON.parse(readFileSync(env.AI_REVIEW_REPORT, 'utf8'))).toMatchObject({
        status: scenario === 'changed' ? 'neutral' : 'success',
        reason: scenario === 'changed' ? 'TARGET_CHANGED' : 'BUDGET_NOTIFIED',
      });
    }
    expect(writes).toEqual(
      ['post', 'failure', 'spoof'].includes(scenario) ? ['issues/25/comments'] : [],
    );
  },
);
