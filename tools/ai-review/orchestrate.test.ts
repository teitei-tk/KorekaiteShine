import { maximumCost, LIMIT, cost } from './budget.ts';
import { ReviewFailure, workerFailure } from './failure.ts';
import { validateTaskResult } from './partition-review.ts';
import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePartitionArtifact, workerEnvironment, decodeWorkerResult } from './orchestrate.ts';
import { verifyPartitionArtifact } from './artifact.ts';
import { indexSources } from './source-index.ts';
import { planReview } from './partition.ts';
import { REPOSITORY } from './policy.ts';

const base = 'b'.repeat(40),
  head = 'a'.repeat(40);
const origin = { run: '10', attempt: '1', sha: 'd'.repeat(40) };
const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.test/token',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret',
  OPENAI_WIF_AUDIENCE: 'aud',
  OPENAI_IDENTITY_PROVIDER_ID: 'idp',
  OPENAI_SERVICE_ACCOUNT_ID: 'service',
  GITHUB_RUN_ID: origin.run,
  GITHUB_RUN_ATTEMPT: origin.attempt,
  GITHUB_SHA: origin.sha,
};
it.each([
  'success',
  'budget',
  'budget-late',
  'expired',
  'late-failure',
  'invalid-evidence',
  'incomplete',
  'worker-incomplete',
  'tampered',
])('分割生成から固定Artifactまで: %s', async (scenario) => {
  const directory = mkdtempSync(join(tmpdir(), 'partition-artifact-'));
  try {
    const index = indexSources(
      (...args) =>
        args[0] === 'ls-tree'
          ? `100644 blob ${'c'.repeat(40)}\tapp.ts\0`
          : 'export const value = 1;',
      [base, head],
    );
    const plan = planReview(
      { number: 1, head, base, partitionVersion: 1, lines: { 'app.ts': [1] } },
      index,
      [{ path: 'app.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' }],
    );
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan));
    writeFileSync(join(directory, 'metadata.json'), JSON.stringify(plan.metadata));
    let exchanges = 0,
      calls = 0;
    const request: typeof fetch = async (url) => {
      if (String(url).startsWith('https://oidc.test'))
        return Response.json({
          value:
            'header.' +
            Buffer.from(
              JSON.stringify({
                iss: 'https://token.actions.githubusercontent.com',
                aud: 'aud',
                repository: REPOSITORY,
                repository_id: '1426899426',
                repository_owner_id: '1324680',
                ref: 'refs/heads/main',
                workflow_ref: `${REPOSITORY}/.github/workflows/ai-review.yml@refs/heads/main`,
                event_name: 'workflow_run',
              }),
            ).toString('base64url') +
            '.signature',
        });
      exchanges++;
      return Response.json({
        access_token: 'secret-' + exchanges,
        expires_at: Math.floor(Date.now() / 1000) + (scenario === 'expired' ? 100 : 300),
      });
    };
    const run = () =>
      generatePartitionArtifact(
        directory,
        {
          ...env,
          GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
          AI_REVIEW_JOB: 'generate',
          AI_REVIEW_REPORT: join(directory, 'status.json'),
        },
        request,
        async (input, token, _plan, budget) => {
          calls++;
          expect(token).toBe('secret-' + calls);
          budget.reserve(10, 'f'.repeat(64));
          if (scenario === 'late-failure' && calls === 2) throw new Error('SECRET');
          budget.settle({ input: 10, cached: 0, written: 0, output: 10, total: 20 });
          const value = {
            status: 'complete' as const,
            summary: '確認',
            uncertainties: [],
            findings:
              input.task.kind === 'reconcile'
                ? []
                : [
                    {
                      priority: 'P2' as const,
                      path: 'app.ts',
                      line: 1,
                      condition: '条件',
                      impact: '影響',
                      fix: '修正',
                    },
                  ],
            checks: [],
            coverage: input.task.obligations,
            evidence:
              input.task.kind === 'reconcile'
                ? []
                : [{ finding: 0, sources: input.task.sources, priorId: null }],
            checkSources: [],
            decisions:
              input.task.kind === 'reconcile'
                ? input.candidates.map((c) => ({
                    id: c.id,
                    disposition: 'keep' as const,
                    duplicateOf: null,
                    reason: '確認',
                    sources: c.sources,
                  }))
                : [],
          };
          if (scenario === 'invalid-evidence' && calls === 2) value.coverage = ['forged'];
          if (['incomplete', 'worker-incomplete'].includes(scenario) && calls === 2) {
            const incomplete = {
              ...value,
              status: 'incomplete' as const,
              summary: 'SECRET_SUMMARY',
              uncertainties: ['SECRET_RAW'],
              incomplete: { subcode: 'MISSING_CONTEXT' as const, missing: ['CONTRACT' as const] },
            };
            if (scenario === 'worker-incomplete') {
              try {
                validateTaskResult(incomplete, plan, input.task);
              } catch (error) {
                if (!(error instanceof ReviewFailure)) throw error;
                const payload = JSON.stringify(workerFailure(error));
                expect(payload).not.toContain('SECRET');
                return decodeWorkerResult(payload);
              }
              throw new Error('未完了が成功扱いされています');
            }
            return { value: incomplete, usage: { input: 10, output: 10, total: 20 } };
          }
          return { value, usage: { input: 10, output: 10, total: 20 } };
        },
        () => {},
        scenario === 'budget'
          ? maximumCost(10) - 1
          : scenario === 'budget-late'
            ? maximumCost(10) +
              cost({ input: 10, cached: 0, written: 0, output: 10, total: 20 }) -
              1
            : LIMIT,
      );
    if (scenario === 'budget' || scenario === 'budget-late') {
      await run();
      expect(existsSync(join(directory, 'budget-result.json'))).toBe(true);
      expect(existsSync(join(directory, 'result.json'))).toBe(false);
      expect(existsSync(join(directory, 'execution.json'))).toBe(false);
      expect(JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))).toMatchObject({
        status: 'neutral',
        reason: 'COST_BUDGET_EXCEEDED',
      });
      expect(calls).toBe(scenario === 'budget' ? 1 : 2);
      expect(readFileSync(join(directory, 'budget.json'), 'utf8')).not.toContain('secret-');
      return;
    }
    if (
      ['expired', 'late-failure', 'invalid-evidence', 'incomplete', 'worker-incomplete'].includes(
        scenario,
      )
    ) {
      await expect(run()).rejects.toThrow();
      expect(existsSync(join(directory, 'execution.json'))).toBe(false);
      expect(existsSync(join(directory, 'result.json'))).toBe(false);
      const summary = readFileSync(join(directory, 'summary.md'), 'utf8');
      const expected =
        scenario === 'expired'
          ? 'AUTH_FAILED'
          : scenario === 'late-failure'
            ? 'MODEL_FAILED'
            : ['incomplete', 'worker-incomplete'].includes(scenario)
              ? 'INCOMPLETE'
              : 'OUTPUT_INVALID';
      expect(summary).toContain(expected);
      expect(JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))).toMatchObject({
        run: '10',
        attempt: '1',
        job: 'generate',
        status: 'failure',
        reason: expected,
        target: scenario === 'expired' ? 'task-1' : 'reconcile-1',
      });
      expect(summary).toContain(scenario === 'expired' ? 'task-1' : 'reconcile-1');
      expect(summary).not.toContain('SECRET');
      expect(summary).not.toContain('secret-');
      const report = readFileSync(join(directory, 'status.json'), 'utf8');
      expect(report).not.toMatch(/SECRET|secret-|oidc-secret/);
      if (scenario === 'invalid-evidence') {
        expect(JSON.parse(report).diagnostic.coverage).toMatchObject({
          expected: 0,
          received: 1,
          foreign: 1,
          duplicates: 0,
          missing: 0,
        });
        expect(summary).toContain('担当外1件');
        expect(summary).not.toContain('forged');
      }
      if (['incomplete', 'worker-incomplete'].includes(scenario)) {
        expect(summary).toContain('MISSING_CONTEXT');
        expect(summary).toContain('CONTRACT');
        expect(JSON.parse(report).diagnostic).toMatchObject({
          subcode: 'MISSING_CONTEXT',
          missing: ['CONTRACT'],
          scope: { kind: 'reconcile', sourceCount: 1 },
        });
      }
      return;
    }
    await run();
    expect(exchanges).toBe(2);
    expect(calls).toBe(2);
    verifyPartitionArtifact(directory, origin);
    for (const path of ['execution.json', 'result.json', 'plan.json'])
      expect(readFileSync(join(directory, path), 'utf8')).not.toContain('secret-');
    if (scenario === 'tampered') {
      writeFileSync(join(directory, 'result.json'), '{}');
      expect(() => verifyPartitionArtifact(directory, origin)).toThrow();
    }
    expect(() => verifyPartitionArtifact(directory, { ...origin, attempt: '2' })).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('モデル子プロセスへOIDC・GitHub・Node設定を継承しない', () => {
  const actual = workerEnvironment('short-token');
  expect(actual).toEqual({ OPENAI_ACCESS_TOKEN: 'short-token' });
});
it('合計入力容量だけでは停止せず認証失敗の対象を記録する', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'partition-budget-summary-'));
  try {
    const paths = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    const index = indexSources(
      (...args) =>
        args[0] === 'ls-tree'
          ? paths.map((p, i) => `100644 blob ${i.toString(16).padStart(40, '0')}\t${p}\0`).join('')
          : `export const value = '${'x'.repeat(220000)}';`,
      [base, head],
    );
    const plan = planReview(
      {
        number: 1,
        head,
        base,
        partitionVersion: 1,
        lines: Object.fromEntries(paths.map((p) => [p, [1]])),
      },
      index,
      paths.map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new\n' })),
    );
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan));
    writeFileSync(join(directory, 'metadata.json'), JSON.stringify(plan.metadata));
    let calls = 0;
    await expect(
      generatePartitionArtifact(
        directory,
        { ...env, GITHUB_STEP_SUMMARY: join(directory, 'summary.md') },
        async () => {
          calls++;
          throw new Error('SECRET');
        },
      ),
    ).rejects.toThrow();
    const summary = readFileSync(join(directory, 'summary.md'), 'utf8');
    expect(summary).toContain('AUTH_FAILED');
    expect(summary).toContain('task-1');
    expect(summary).toContain(`0/${plan.tasks.length}`);
    expect(summary).not.toContain('SECRET');
    expect(calls).toBe(1);
    expect(existsSync(join(directory, 'result.json'))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('子プロセスの未知分類・自由文を診断として受け入れない', () => {
  for (const extra of [
    { subcode: 'SECRET', missing: [] },
    { subcode: 'MISSING_CONTEXT', missing: ['CONTRACT'], text: 'SECRET' },
  ])
    expect(() =>
      decodeWorkerResult(JSON.stringify({ failure: 'INCOMPLETE', detail: extra })),
    ).toThrow(
      expect.objectContaining({
        reason: 'OUTPUT_INVALID',
        detail: { subcode: 'INVALID_DIAGNOSTIC', missing: [] },
      }),
    );
  const payload = workerFailure(new ReviewFailure('INCOMPLETE', 'SECRET_ERROR'));
  expect(JSON.stringify(payload)).not.toContain('SECRET');
  expect(() => decodeWorkerResult(JSON.stringify(payload))).toThrow(
    expect.objectContaining({ reason: 'INCOMPLETE' }),
  );
});

it('認証中の総時間超過を固定理由で保存し、予算通知や部分結果を作らない', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-timeout-'));
  try {
    const index = indexSources(
      (...args) =>
        args[0] === 'ls-tree'
          ? `100644 blob ${'c'.repeat(40)}\tapp.ts\0`
          : 'export const value = 1;',
      [base, head],
    );
    const plan = planReview(
      { number: 1, head, base, partitionVersion: 1, lines: { 'app.ts': [1] } },
      index,
      [{ path: 'app.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' }],
    );
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan));
    writeFileSync(join(directory, 'metadata.json'), JSON.stringify(plan.metadata));
    let aborted = false,
      calls = 0;
    await expect(
      generatePartitionArtifact(
        directory,
        {
          ...env,
          AI_REVIEW_JOB: 'generate',
          AI_REVIEW_REPORT: join(directory, 'status.json'),
          GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
        },
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('SECRET'));
            });
          }),
        async () => {
          calls++;
          throw new Error('モデルは開始しない');
        },
        () => {},
        LIMIT,
        20,
      ),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(calls).toBe(0);
    expect(readFileSync(join(directory, 'status.json'), 'utf8')).toContain('TIME_BUDGET_EXCEEDED');
    expect(readFileSync(join(directory, 'summary.md'), 'utf8')).not.toContain('SECRET');
    for (const path of ['result.json', 'execution.json', 'budget-result.json'])
      expect(existsSync(join(directory, path))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
