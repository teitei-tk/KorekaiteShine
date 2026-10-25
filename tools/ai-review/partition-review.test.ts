import { expect, it } from 'vitest';
import { runPartitionReview, preflight, validateTaskResult } from './partition-review.ts';
import type { TaskResult, TaskInvocation } from './partition-review.ts';
import { planReview } from './partition.ts';
import { indexSources } from './source-index.ts';

function fixture() {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree' ? `100644 blob ${'c'.repeat(40)}\tapp.ts\0` : 'export const value = 1;',
    [base, head],
  );
  return planReview({ number: 1, base, head, lines: { 'app.ts': [1] } }, index, [
    { path: 'app.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' },
  ]);
}
function response(task: TaskInvocation): TaskResult {
  return {
    status: 'complete',
    summary: '確認済み',
    uncertainties: [],
    findings: [],
    checks: [],
    coverage: task.task.obligations,
    evidence: [],
    checkSources: [],
    decisions: [],
  };
}
it('全作業の処理完了を記録し、未担当の対象IDを拒否する', async () => {
  const plan = fixture();
  const result = await runPartitionReview(plan, async (input) => ({
    value: response(input),
    usage: { input: 10, output: 20, total: 30 },
  }));
  expect(result.completed).toEqual(plan.tasks.map((t) => t.id));
  const input = preflight(plan)[0];
  expect(() =>
    validateTaskResult({ ...response(input), coverage: ['forged'] }, plan, input.task),
  ).toThrow();
});
it('途中失敗とincompleteを最終レビューに変換しない', async () => {
  const plan = fixture();
  await expect(
    runPartitionReview(plan, async (input) => ({
      value: { ...response(input), status: 'incomplete' },
      usage: { input: 1, output: 1, total: 2 },
    })),
  ).rejects.toThrow();
});
it('存在しない根拠とhead以外の投稿位置を拒否する', () => {
  const plan = fixture(),
    input = preflight(plan)[0];
  const finding = {
    priority: 'P2' as const,
    path: 'app.ts',
    line: 1,
    condition: '条件',
    impact: '影響',
    fix: '修正',
  };
  expect(() =>
    validateTaskResult(
      {
        ...response(input),
        findings: [finding],
        evidence: [{ finding: 0, sources: ['missing'], priorId: null }],
      },
      plan,
      input.task,
    ),
  ).toThrow();
});
it('候補整理に原文を渡し、同じ候補の再投稿を防ぐ', async () => {
  const plan = fixture();
  let calls = 0;
  const result = await runPartitionReview(plan, async (input) => {
    calls++;
    const value = response(input);
    if (input.task.kind === 'reconcile') {
      expect(input.prompt).toContain('export const value = 1;');
      value.decisions = input.candidates.map((c) => ({
        id: c.id,
        disposition: 'keep',
        duplicateOf: null,
        reason: '原文で確認',
        sources: c.sources,
      }));
    } else {
      value.findings = [
        { priority: 'P2', path: 'app.ts', line: 1, condition: '条件', impact: '影響', fix: '修正' },
      ];
      value.evidence = [{ finding: 0, sources: [plan.sources[0].id], priorId: null }];
    }
    return { value, usage: { input: 1, output: 1, total: 2 } };
  });
  expect(calls).toBe(2);
  expect(result.review.findings).toHaveLength(1);
});
it('候補整理で候補が欠落したら未完了で止める', async () => {
  const plan = fixture();
  await expect(
    runPartitionReview(plan, async (input) => {
      const value = response(input);
      if (input.task.kind !== 'reconcile') {
        value.findings = [
          {
            priority: 'P2',
            path: 'app.ts',
            line: 1,
            condition: '条件',
            impact: '影響',
            fix: '修正',
          },
        ];
        value.evidence = [{ finding: 0, sources: [plan.sources[0].id], priorId: null }];
      }
      return { value, usage: { input: 1, output: 1, total: 2 } };
    }),
  ).rejects.toThrow(/候補/);
});
it('後半作業が失敗したら先行候補があっても結果を返さない', async () => {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree' ? `100644 blob ${'c'.repeat(40)}\tapp.ts\0` : 'export const value = 1;',
    [base, head],
  );
  const prior = {
    id: '9:1',
    head: base,
    base,
    priority: 'P2' as const,
    path: 'app.ts',
    line: 1,
    condition: '過去',
    impact: '影響',
    fix: '修正',
  };
  const plan = planReview(
    { number: 1, base, head, lines: { 'app.ts': [1] }, priorFindings: [prior] },
    index,
    [{ path: 'app.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' }],
  );
  let completed = 0;
  await expect(
    runPartitionReview(
      plan,
      async (input) => {
        if (input.task.kind === 'history') throw new Error('late failure');
        return { value: response(input), usage: { input: 1, output: 1, total: 2 } };
      },
      (count) => {
        completed = count;
      },
    ),
  ).rejects.toThrow('late failure');
  expect(completed).toBe(1);
});
it('過去指摘30件を新規候補とは別枠で全件確認する', async () => {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree' ? `100644 blob ${'c'.repeat(40)}\tapp.ts\0` : 'export const value = 1;',
    [base, head],
  );
  const prior = Array.from({ length: 30 }, (_, i) => ({
    id: `${i + 1}:1`,
    head: base,
    base,
    priority: 'P2' as const,
    path: 'app.ts',
    line: 1,
    condition: `過去${i}`,
    impact: '影響',
    fix: '修正',
  }));
  const plan = planReview(
    { number: 1, base, head, lines: { 'app.ts': [1] }, priorFindings: prior },
    index,
    [{ path: 'app.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' }],
  );
  const result = await runPartitionReview(plan, async (input) => {
    const value = response(input);
    value.checks = input.task.priorIds.map((id) => ({
      id,
      status: 'unverified' as const,
      evidence: '原文を確認したが条件を特定できない',
    }));
    value.checkSources = input.task.priorIds.map((id) => ({ id, sources: input.task.sources }));
    return { value, usage: { input: 1, output: 1, total: 2 } };
  });
  expect(result.review.checks?.map((c) => c.id).sort()).toEqual(prior.map((p) => p.id).sort());
  expect(result.review.findings).toEqual([]);
});
it('既存指摘との対応を候補整理が覆したら停止する', async () => {
  const plan = fixture();
  const prior = {
    id: '9:1',
    head: plan.metadata.base,
    base: plan.metadata.base,
    priority: 'P2' as const,
    path: 'app.ts',
    line: 1,
    condition: '前の表現',
    impact: '影響',
    fix: '修正',
  };
  const sources = indexSources(
    (...args) =>
      args[0] === 'ls-tree' ? `100644 blob ${'c'.repeat(40)}\tapp.ts\0` : 'export const value = 1;',
    [plan.metadata.base, plan.metadata.head],
  );
  const withHistory = planReview({ ...plan.metadata, priorFindings: [prior] }, sources, [
    { path: 'app.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' },
  ]);
  await expect(
    runPartitionReview(withHistory, async (input) => {
      const value = response(input);
      if (input.task.kind === 'unit') {
        value.findings = [
          {
            priority: 'P2',
            path: 'app.ts',
            line: 1,
            condition: '別の表現',
            impact: '影響',
            fix: '修正',
          },
        ];
        value.evidence = [{ finding: 0, sources: input.task.sources, priorId: '9:1' }];
      }
      if (input.task.kind === 'history') {
        value.checks = [{ id: '9:1', status: 'unfixed', evidence: '残っている' }];
        value.checkSources = [{ id: '9:1', sources: input.task.sources }];
      }
      if (input.task.kind === 'reconcile')
        value.decisions = input.candidates.map((c) => ({
          id: c.id,
          disposition: 'keep',
          duplicateOf: null,
          reason: '別扱い',
          sources: c.sources,
        }));
      return { value, usage: { input: 1, output: 1, total: 2 } };
    }),
  ).rejects.toThrow(/既存指摘/);
});
it('入力総量が予算を超える計画ではモデルを一度も呼ばない', async () => {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const paths = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? paths.map((p, i) => `100644 blob ${i.toString(16).padStart(40, '0')}\t${p}\0`).join('')
        : `export const value = '${'x'.repeat(220000)}';`,
    [base, head],
  );
  const plan = planReview(
    { number: 1, head, base, lines: Object.fromEntries(paths.map((p) => [p, [1]])) },
    index,
    paths.map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new\n' })),
  );
  let calls = 0;
  await expect(
    runPartitionReview(plan, async (input) => {
      calls++;
      return { value: response(input), usage: { input: 1, output: 1, total: 2 } };
    }),
  ).rejects.toThrow(/予算/);
  expect(calls).toBe(0);
});
it('指摘行を含まない別ファイルだけを根拠として返す応答を拒否する', () => {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? `100644 blob ${'c'.repeat(40)}\tapp.ts\0` + `100644 blob ${'d'.repeat(40)}\tother.ts\0`
        : 'export const value = 1;',
    [base, head],
  );
  const plan = planReview(
    { number: 1, head, base, lines: { 'app.ts': [1], 'other.ts': [1] } },
    index,
    ['app.ts', 'other.ts'].map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new\n' })),
  );
  const input = preflight(plan)[0];
  expect(() =>
    validateTaskResult(
      {
        ...response(input),
        findings: [
          {
            priority: 'P2',
            path: 'app.ts',
            line: 1,
            condition: '条件',
            impact: '影響',
            fix: '修正',
          },
        ],
        evidence: [
          {
            finding: 0,
            sources: [plan.sources.find((s) => s.path === 'other.ts')!.id],
            priorId: null,
          },
        ],
      },
      plan,
      input.task,
    ),
  ).toThrow();
});
it('既存指摘の再発候補と履歴fixedの矛盾を完了扱いしない', async () => {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree' ? `100644 blob ${'c'.repeat(40)}\tapp.ts\0` : 'export const value = 1;',
    [base, head],
  );
  const prior = {
    id: '9:1',
    head: base,
    base,
    priority: 'P2' as const,
    path: 'app.ts',
    line: 1,
    condition: '以前の問題',
    impact: '影響',
    fix: '修正',
  };
  const plan = planReview(
    { number: 1, base, head, lines: { 'app.ts': [1] }, priorFindings: [prior] },
    index,
    [{ path: 'app.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' }],
  );
  await expect(
    runPartitionReview(plan, async (input) => {
      const value = response(input);
      if (input.task.kind === 'unit') {
        value.findings = [
          {
            priority: 'P2',
            path: 'app.ts',
            line: 1,
            condition: '同じ問題が残っている',
            impact: '影響',
            fix: '修正',
          },
        ];
        value.evidence = [{ finding: 0, sources: input.task.sources, priorId: '9:1' }];
      } else if (input.task.kind === 'history') {
        value.checks = [{ id: '9:1', status: 'fixed', evidence: '修正済みと判断' }];
        value.checkSources = [{ id: '9:1', sources: input.task.sources }];
      } else {
        expect(input.prompt).toContain('"status":"fixed"');
        expect(input.prompt).toContain('"evidence":"修正済みと判断"');
        value.decisions = input.candidates.map((c) => ({
          id: c.id,
          disposition: 'duplicate',
          duplicateOf: '9:1',
          reason: '既存の同じ問題',
          sources: c.sources,
        }));
      }
      return { value, usage: { input: 1, output: 1, total: 2 } };
    }),
  ).rejects.toThrow(/矛盾/);
});
it.each([1000, 175000])('重複棄却は双方の原文と引用を必要とする: %iバイト', async (size) => {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const paths = ['one.ts', 'two.ts'];
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? paths.map((p, i) => `100644 blob ${i.toString(16).padStart(40, '0')}\t${p}\0`).join('')
        : `export const value = '${'x'.repeat(size)}';`,
    [base, head],
  );
  const plan = planReview(
    { number: 1, base, head, lines: { 'one.ts': [1], 'two.ts': [1] } },
    index,
    paths.map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new\n' })),
  );
  const run = () =>
    runPartitionReview(plan, async (input) => {
      const value = response(input);
      if (input.task.kind === 'reconcile') {
        value.decisions = input.task.candidateIds!.map((id) => {
          const candidate = input.candidates.find((c) => c.id === id)!;
          const other = input.candidates.find((c) => c.finding.path === 'two.ts')!;
          return {
            id,
            disposition:
              candidate.finding.path === 'one.ts' ? ('duplicate' as const) : ('keep' as const),
            duplicateOf: candidate.finding.path === 'one.ts' ? other.id : null,
            reason: '同一問題',
            sources: [
              ...new Set([
                ...candidate.sources,
                ...other.sources.filter((id) => input.task.sources.includes(id)),
              ]),
            ],
          };
        });
      } else {
        const sources = plan.sources.filter((s) => input.task.sources.includes(s.id));
        value.findings = sources.map((s) => ({
          priority: 'P2',
          path: s.path,
          line: 1,
          condition: '条件',
          impact: '影響',
          fix: '修正',
        }));
        value.evidence = sources.map((s, i) => ({ finding: i, sources: [s.id], priorId: null }));
      }
      return { value, usage: { input: 1, output: 1, total: 2 } };
    });
  if (size === 175000) await expect(run()).rejects.toThrow(/重複先.*原文/);
  else expect((await run()).review.findings.map((f) => f.path)).toEqual(['two.ts']);
});
it('モデル申告の不足情報を固定分類だけで引き継ぐ', () => {
  const plan = fixture(),
    input = preflight(plan)[0];
  expect(() =>
    validateTaskResult(
      {
        ...response(input),
        status: 'incomplete',
        summary: 'SECRET_SUMMARY',
        uncertainties: ['SECRET_TEXT'],
        incomplete: { subcode: 'MISSING_CONTEXT', missing: ['CONTRACT'] },
      },
      plan,
      input.task,
    ),
  ).toThrow(
    expect.objectContaining({
      reason: 'INCOMPLETE',
      detail: { subcode: 'MISSING_CONTEXT', missing: ['CONTRACT'] },
    }),
  );
});
it('モデル診断の未知コードや自由文を記録しない', () => {
  const plan = fixture(),
    input = preflight(plan)[0];
  const invalid = {
    ...response(input),
    status: 'incomplete' as const,
    incomplete: { subcode: 'MISSING_CONTEXT' as const, missing: [], text: 'SECRET' },
  };
  expect(() => validateTaskResult(invalid, plan, input.task)).toThrow(
    expect.objectContaining({
      reason: 'OUTPUT_INVALID',
      detail: { subcode: 'INVALID_DIAGNOSTIC', missing: [] },
    }),
  );
});
