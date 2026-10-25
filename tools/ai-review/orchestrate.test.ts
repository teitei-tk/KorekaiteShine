import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePartitionArtifact, workerEnvironment } from './orchestrate.ts';
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
it.each(['success', 'expired', 'late-failure', 'invalid-evidence', 'incomplete', 'tampered'])(
  '分割生成から固定Artifactまで: %s',
  async (scenario) => {
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
          async (input, token) => {
            calls++;
            expect(token).toBe('secret-' + calls);
            if (scenario === 'late-failure' && calls === 2) throw new Error('SECRET');
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
            if (scenario === 'incomplete' && calls === 2)
              return {
                value: { ...value, status: 'incomplete' as const },
                usage: { input: 10, output: 10, total: 20 },
              };
            return { value, usage: { input: 10, output: 10, total: 20 } };
          },
          () => {},
        );
      if (['expired', 'late-failure', 'invalid-evidence', 'incomplete'].includes(scenario)) {
        await expect(run()).rejects.toThrow();
        expect(existsSync(join(directory, 'execution.json'))).toBe(false);
        expect(existsSync(join(directory, 'result.json'))).toBe(false);
        const summary = readFileSync(join(directory, 'summary.md'), 'utf8');
        const expected =
          scenario === 'expired'
            ? 'AUTH_FAILED'
            : scenario === 'late-failure'
              ? 'MODEL_FAILED'
              : scenario === 'incomplete'
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
  },
);
it('モデル子プロセスへOIDC・GitHub・Node設定を継承しない', () => {
  const actual = workerEnvironment('short-token');
  expect(actual).toEqual({ OPENAI_ACCESS_TOKEN: 'short-token' });
});
it('課金前の予算超過も対象と理由を記録し外部エラーを表示しない', async () => {
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
    expect(summary).toContain('BUDGET_EXCEEDED');
    expect(summary).toContain('preflight');
    expect(summary).toContain('0/10');
    expect(summary).not.toContain('SECRET');
    expect(calls).toBe(0);
    expect(existsSync(join(directory, 'result.json'))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
