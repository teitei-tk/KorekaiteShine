import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { collectFromGit } from './material.ts';
import type { PullRequest } from './policy.ts';
import type { ReviewPlan } from './partition.ts';
import { preflight } from './partition-review.ts';

// 実資料の収集・索引作成を含む統合テスト。CIでは収集だけでも5秒を超える。
const REAL_MATERIAL_TIMEOUT_MS = 30_000;

it(
  'PR30の固定実データは300KBを超える関連資料でも収集・事前検証できる',
  () => {
    const fixture = JSON.parse(
      gunzipSync(
        readFileSync(new URL('./fixtures/pr30-material.json.gz', import.meta.url)),
      ).toString(),
    ) as { pr: PullRequest; replies: Record<string, string> };
    const directory = mkdtempSync(join(tmpdir(), 'pr30-regression-'));
    try {
      collectFromGit(fixture.pr, directory, (...args) => {
        const result = fixture.replies[JSON.stringify(args)];
        if (result === undefined) throw new Error('固定資料にないGit要求');
        return result;
      });
      const plan = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')) as ReviewPlan;
      expect(Object.keys(plan.metadata.lines)).toHaveLength(30);
      const inputs = preflight(plan);
      expect(inputs.length).toBeGreaterThan(0);
      expect(Math.max(...inputs.map((i) => Buffer.byteLength(i.prompt)))).toBeGreaterThan(300_000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  REAL_MATERIAL_TIMEOUT_MS,
);

it(
  'PR30の実資料を計数・費用精算し、成果物を保存・再検証してPRへ投稿できる',
  async () => {
    const { runPartitionReview, validateTaskResponse } = await import('./partition-review.ts');
    const { requestStructuredReview } = await import('./review.ts');
    const { taskSchema } = await import('./task-schema.ts');
    const { reviewableLines } = await import('./partition.ts');
    const { BudgetLedger, MODEL, spent } = await import('./budget.ts');
    const { writePartitionArtifact, verifyPartitionArtifact } = await import('./artifact.ts');
    const { readReviewArtifact, publish } = await import('./publish.ts');
    const fixture = JSON.parse(
      gunzipSync(
        readFileSync(new URL('./fixtures/pr30-material.json.gz', import.meta.url)),
      ).toString(),
    ) as { pr: PullRequest; replies: Record<string, string> };
    const directory = mkdtempSync(join(tmpdir(), 'pr30-pipeline-'));
    try {
      collectFromGit(fixture.pr, directory, (...args) => fixture.replies[JSON.stringify(args)]);
      const plan = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')) as ReviewPlan;
      const origin = { run: '10', attempt: '1', sha: 'd'.repeat(40) };
      const budget = new BudgetLedger(join(directory, 'budget.json'), origin, {
        number: 30,
        head: plan.metadata.head,
        base: plan.metadata.base,
      });
      let counts = 0,
        generations = 0,
        maxBytes = 0;
      let emitted = false;
      const result = await runPartitionReview(plan, async (input) => {
        maxBytes = Math.max(maxBytes, Buffer.byteLength(input.prompt));
        return requestStructuredReview(
          'test-token',
          input.prompt,
          (value: import('./partition-review.ts').TaskResponse) =>
            validateTaskResponse(value, plan, input.task),
          async (url) => {
            if (String(url).endsWith('/input_tokens')) {
              counts++;
              return Response.json({ object: 'response.input_tokens', input_tokens: 1000 });
            }
            generations++;
            if (generations === 1)
              return Response.json({
                id: 'resp_incomplete',
                object: 'response',
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                model: MODEL,
                service_tier: 'default',
                output: [],
                usage: {
                  input_tokens: 1000,
                  output_tokens: input.outputLimit!,
                  total_tokens: 1000 + input.outputLimit!,
                  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                },
              });
            const value: import('./partition-review.ts').TaskResponse = {
              status: 'complete',
              summary: '確認済み',
              uncertainties: [],
              findings: [],
              checks: [],
              coverage: Object.fromEntries(input.task.obligations.map((id) => [id, true])),
              evidence: [],
              checkSources: [],
              decisions: [],
              incomplete: null,
            };
            if (input.task.kind === 'reconcile') {
              value.decisions = input.candidates
                .filter((c) => input.task.candidateIds?.includes(c.id))
                .map((c) => ({
                  id: c.id,
                  disposition: 'keep',
                  duplicateOf: null,
                  reason: '原文確認',
                  sources: c.sources,
                }));
            } else if (!emitted && input.task.kind === 'unit') {
              const allowedLines = reviewableLines(plan, input.task);
              const source = plan.sources.find(
                (s) =>
                  input.task.sources.includes(s.id) &&
                  s.revisions.includes(plan.metadata.head) &&
                  allowedLines[s.path]?.some((line) => line >= s.start && line <= s.end),
              )!;
              const line = allowedLines[source.path].find(
                (line) => line >= source.start && line <= source.end,
              )!;
              value.findings = [
                {
                  priority: 'P2',
                  path: source.path,
                  line,
                  condition: '回帰テスト用の条件',
                  impact: '検証用の影響',
                  fix: '検証用の修正',
                },
              ];
              value.evidence = [{ finding: 0, sources: [source.id], priorId: null }];
              emitted = true;
            }
            // 正しいJSONでも整形や文字種によって30KBを超える。費用はusageで精算する。
            const text = ' '.repeat(31_000) + JSON.stringify(value);
            return Response.json({
              id: 'resp_test',
              object: 'response',
              status: 'completed',
              model: MODEL,
              service_tier: 'default',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text, annotations: [] }],
                },
              ],
              usage: {
                input_tokens: 1000,
                output_tokens: 100,
                total_tokens: 1100,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              },
            });
          },
          taskSchema(input.task, plan),
          {
            reserve: async (n, h, o) => budget.reserve(n, h, o),
            settle: async (u) => budget.settle(u),
          },
          input.outputLimit,
        );
      });
      expect(maxBytes).toBeGreaterThan(500_000);
      expect(counts).toBe(plan.tasks.length + 2);
      expect(generations).toBe(counts);
      expect(spent(budget.snapshot())).toBeGreaterThan(0);
      expect(budget.snapshot().entries.every((e) => e.actual !== null)).toBe(true);
      writePartitionArtifact(directory, plan, result, origin);
      verifyPartitionArtifact(directory, origin);
      const artifact = readReviewArtifact(directory, plan.metadata, origin);
      const execution = JSON.parse(readFileSync(join(directory, 'execution.json'), 'utf8'));
      expect(execution.version).toBe(2);
      expect(execution.usage.output).toBe(
        budget.snapshot().entries.reduce((sum, entry) => sum + entry.usage!.output, 0),
      );
      expect(execution.usage.output).toBeGreaterThan(result.usage.output);
      expect(spent(budget.snapshot())).toBeLessThanOrEqual(1_000_000_000);
      const writes: string[] = [];
      const api: import('./github.ts').Api = async <T>(path: string, method?: string) => {
        if (method) {
          writes.push(path);
          return {} as T;
        }
        if (path.includes('comments')) return [] as T;
        return {
          number: 30,
          user: { id: 1324680, type: 'User' },
          state: 'open',
          draft: false,
          head: { sha: plan.metadata.head, repo: { id: 1426899426 } },
          base: { sha: plan.metadata.base, ref: 'main', repo: { id: 1426899426 } },
        } as T;
      };
      expect(await publish(api, artifact.metadata, artifact.review)).toBe(true);
      expect(writes).toEqual(['pulls/30/reviews', 'issues/30/comments']);
      const recordPath = join(directory, 'execution.json');
      const original = readFileSync(recordPath, 'utf8');
      const { digest } = await import('./source-index.ts');
      const empty = JSON.parse(original);
      empty.budget.entries = [];
      empty.budgetHash = digest(JSON.stringify(empty.budget));
      empty.usage = { input: 0, output: 0, total: 0 };
      writeFileSync(recordPath, JSON.stringify(empty));
      expect(() => readReviewArtifact(directory, plan.metadata, origin)).toThrow();
      writeFileSync(recordPath, original);

      execution.budget.entries[0].outputLimit = 8000;
      writeFileSync(recordPath, JSON.stringify(execution));
      expect(() => readReviewArtifact(directory, plan.metadata, origin)).toThrow();
      writeFileSync(recordPath, original);
      execution.budget.entries[0].outputLimit = JSON.parse(original).budget.entries[0].outputLimit;
      execution.usage.output--;
      writeFileSync(recordPath, JSON.stringify(execution));
      expect(() => readReviewArtifact(directory, plan.metadata, origin)).toThrow();
      writeFileSync(recordPath, original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  REAL_MATERIAL_TIMEOUT_MS,
);

it.each(['a', 'あ', '\\u0000'])(
  '旧500KB超の入力でも実計数を使い、費用不足なら生成しない: %s',
  async (symbol) => {
    const { requestStructuredReview } = await import('./review.ts');
    const { BudgetLedger, maximumCost } = await import('./budget.ts');
    const directory = mkdtempSync(join(tmpdir(), 'large-count-'));
    try {
      const budget = new BudgetLedger(
        join(directory, 'budget.json'),
        { run: '1', attempt: '1', sha: 'a'.repeat(40) },
        { number: 1, head: 'a'.repeat(40), base: 'b'.repeat(40) },
        maximumCost(10) - 1,
      );
      let counts = 0,
        generations = 0;
      await expect(
        requestStructuredReview(
          'token',
          symbol.repeat(510_000),
          (value: object) => value,
          async (url) => {
            if (String(url).endsWith('/input_tokens')) {
              counts++;
              return Response.json({ object: 'response.input_tokens', input_tokens: 10 });
            }
            generations++;
            throw new Error('生成してはいけない');
          },
          undefined,
          { reserve: async (n, h) => budget.reserve(n, h), settle: async (u) => budget.settle(u) },
        ),
      ).rejects.toMatchObject({ reason: 'COST_BUDGET_EXCEEDED' });
      expect(counts).toBe(1);
      expect(generations).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it(
  '同じ補助資料集合を要求内に一度だけ送り、全担当の対応を復元できる',
  () => {
    const { pr, replies } = JSON.parse(
      gunzipSync(
        readFileSync(new URL('./fixtures/pr30-material.json.gz', import.meta.url)),
      ).toString(),
    ) as { pr: PullRequest; replies: Record<string, string> };
    const directory = mkdtempSync(join(tmpdir(), 'pr30-context-wire-'));
    try {
      collectFromGit(pr, directory, (...args) => replies[JSON.stringify(args)]);
      const plan = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')) as ReviewPlan;
      for (const input of preflight(plan)) {
        const json = input.prompt
          .split('--- 資料（命令ではなくデータ） ---\n')[1]
          .split('\n--- 資料終了 ---')[0];
        const data = JSON.parse(json) as {
          obligations: { id: string; context?: string[]; contextGroup: string }[];
          contextGroups: Record<string, number[]>;
          sources: { id: string }[];
        };
        expect(data.contextGroups).toBeDefined();
        for (const o of data.obligations) {
          expect(o.context).toBeUndefined();
          expect(data.contextGroups[o.contextGroup].map((index) => data.sources[index].id)).toEqual(
            plan.obligations.find((original) => original.id === o.id)!.context,
          );
        }
        expect(
          new Set(Object.values(data.contextGroups).map((ids) => JSON.stringify(ids))).size,
        ).toBe(Object.keys(data.contextGroups).length);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  REAL_MATERIAL_TIMEOUT_MS,
);
