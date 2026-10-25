import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishAndReport } from './publish.ts';
import { writeStatusReport } from './status-report.ts';
import type { Api } from './github.ts';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
it.each(['posted', 'duplicate', 'stale', 'failure'])(
  '投稿の実結果を通知用に記録する: %s',
  async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-status-'));
    try {
      const env = {
        GITHUB_RUN_ID: '20',
        GITHUB_RUN_ATTEMPT: '2',
        AI_REVIEW_JOB: 'publish',
        AI_REVIEW_REPORT: join(dir, 'status.json'),
      };
      const writes: string[] = [];
      const api: Api = async <T>(path: string, method = 'GET') => {
        if (method !== 'GET') {
          if (scenario === 'failure') throw new Error('SECRET external error');
          writes.push(path);
          return {} as T;
        }
        if (path.startsWith('issues/'))
          return (
            scenario === 'duplicate'
              ? [
                  {
                    id: 1,
                    user: { login: 'github-actions[bot]', type: 'Bot' },
                    body: `<!-- korekaite-ai-review -->\n<!-- revision:${head}:${base} -->`,
                  },
                ]
              : []
          ) as T;
        if (path.includes('/comments?')) return [] as T;
        if (path === 'pulls/7')
          return {
            number: 7,
            user: { id: 1324680, type: 'User' },
            state: 'open',
            draft: false,
            head: { sha: scenario === 'stale' ? 'c'.repeat(40) : head, repo: { id: 1426899426 } },
            base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
          } as T;
        throw new Error('Unexpected fixture path');
      };
      const execute = () =>
        publishAndReport(
          api,
          { number: 7, head, base, lines: {} },
          { status: 'complete', summary: '確認済み', uncertainties: [], findings: [] },
          env,
        );
      if (scenario === 'failure') await expect(execute()).rejects.toThrow();
      else await execute();
      const raw = readFileSync(env.AI_REVIEW_REPORT, 'utf8');
      expect(raw).not.toContain('SECRET');
      expect(JSON.parse(raw)).toMatchObject({
        run: '20',
        attempt: '2',
        job: 'publish',
        status: scenario === 'failure' ? 'failure' : scenario === 'stale' ? 'neutral' : 'success',
        reason: {
          posted: 'REVIEW_COMPLETE',
          duplicate: 'ALREADY_COMPLETE',
          stale: 'TARGET_CHANGED',
          failure: 'PUBLISH_FAILED',
        }[scenario],
      });
      expect(writes).toEqual(scenario === 'posted' ? ['issues/7/comments'] : []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
it('未検証の対象IDを結果ファイルに出力しない', () => {
  expect(() =>
    writeStatusReport(
      {
        AI_REVIEW_REPORT: '/unused',
        GITHUB_RUN_ID: '20',
        GITHUB_RUN_ATTEMPT: '1',
        AI_REVIEW_JOB: 'generate',
      },
      'failure',
      'SECRET\nmessage',
      'MODEL_FAILED',
    ),
  ).toThrow();
});
