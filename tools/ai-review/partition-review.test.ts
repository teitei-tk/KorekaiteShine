import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePartitionArtifact } from './artifact.ts';
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
  const { ReviewFailure } = await import('./failure.ts');
  const { detail } = await import('./diagnostics.ts');
  const recovered = new Set<string>();
  const result = await runPartitionReview(plan, async (input) => {
    if (input.task.kind === 'history' && !recovered.has(input.task.id)) {
      recovered.add(input.task.id);
      throw new ReviewFailure('INCOMPLETE', '不足', detail('TOKEN_LIMIT'));
    }
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
it('合計3MB超でもバイト数だけで分割レビューを拒否しない', async () => {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const paths = Array.from({ length: 13 }, (_, i) => `f${i}.ts`);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? paths.map((p, i) => `100644 blob ${i.toString(16).padStart(40, '0')}\t${p}\0`).join('')
        : `export const value = '${'x'.repeat(298000)}';`,
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
  let calls = 0;
  const result = await runPartitionReview(plan, async (input) => {
    calls++;
    return { value: response(input), usage: { input: 1, output: 8000, total: 8001 } };
  });
  expect(result.inputBytes).toBeGreaterThan(3_000_000);
  expect(calls).toBe(plan.tasks.length);
  const directory = mkdtempSync(join(tmpdir(), 'review-many-'));
  writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify(plan.metadata));
  expect(() =>
    writePartitionArtifact(directory, plan, result, {
      run: '1',
      attempt: '1',
      sha: head,
    }),
  ).not.toThrow();
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
          const other = input.candidates.find((c) => c.id !== candidate.id);
          return {
            id,
            disposition: other ? ('duplicate' as const) : ('keep' as const),
            duplicateOf: other?.id ?? null,
            reason: '同一問題',
            sources: [
              ...new Set([
                ...candidate.sources,
                ...(other?.sources ?? []).filter((id) => input.task.sources.includes(id)),
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
  expect((await run()).review.findings).toHaveLength(1);
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

it('候補整理は原文が旧容量上限を超えても全候補を確認する', async () => {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const paths = Array.from({ length: 3 }, (_, i) => `f${i}.ts`);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? paths.map((p, i) => `100644 blob ${i.toString(16).padStart(40, '0')}\t${p}\0`).join('')
        : `export const value = '${'x'.repeat(298000)}';`,
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
  let calls = 0;
  const result = await runPartitionReview(plan, async (input) => {
    calls++;
    const value = response(input);
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
    } else {
      const sources = plan.sources.filter((source) => input.task.sources.includes(source.id));
      value.findings = sources.map((source) => ({
        priority: 'P2',
        path: source.path,
        line: 1,
        condition: '条件',
        impact: '影響',
        fix: '修正',
      }));
      value.evidence = sources.map((source, finding) => ({
        finding,
        sources: [source.id],
        priorId: null,
      }));
    }
    return { value, usage: { input: 1, output: 1, total: 2 } };
  });
  expect(result.review.findings).toHaveLength(3);
  expect(calls).toBe(plan.tasks.length + result.candidateCount);
  const directory = mkdtempSync(join(tmpdir(), 'review-many-'));
  writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify(plan.metadata));
  expect(() =>
    writePartitionArtifact(directory, plan, result, {
      run: '1',
      attempt: '1',
      sha: head,
    }),
  ).not.toThrow();
});

it('担当外の履歴確認を返した応答は対象不一致の固定理由で拒否する', () => {
  const plan = fixture(),
    input = preflight(plan)[0];
  const value = response(input);
  value.checks = [{ id: '9:1', status: 'fixed', evidence: 'SECRET_MODEL_OUTPUT' }];
  expect(() => validateTaskResult(value, plan, input.task)).toThrow(
    expect.objectContaining({
      reason: 'OUTPUT_INVALID',
      detail: { subcode: 'CHECK_TARGET_MISMATCH', missing: [] },
    }),
  );
});

it('修正済み履歴はhistoryだけが判定し、単位作業と統合して全件返す', async () => {
  const original = fixture();
  const prior = {
    id: '9:1',
    head: original.metadata.base,
    base: original.metadata.base,
    priority: 'P2' as const,
    path: 'app.ts',
    line: 1,
    condition: '比較が逆',
    impact: '誤許可',
    fix: '<=へ修正',
  };
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? `100644 blob ${'c'.repeat(40)}\tapp.ts\0`
        : 'export const allowed = spent + next <= limit;',
    [original.metadata.base, original.metadata.head],
  );
  const plan = planReview({ ...original.metadata, priorFindings: [prior] }, index, [
    { path: 'app.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' },
  ]);
  const kinds: string[] = [];
  const result = await runPartitionReview(plan, async (input) => {
    kinds.push(input.task.kind);
    expect(input.prompt).toContain('担当外の履歴は重複回避の参考情報');
    const value = response(input);
    value.checks = input.task.priorIds.map((id) => ({
      id,
      status: 'fixed' as const,
      evidence: 'headの<=判定を確認',
    }));
    value.checkSources = input.task.priorIds.map((id) => ({ id, sources: input.task.sources }));
    return { value, usage: { input: 1, output: 1, total: 2 } };
  });
  expect(kinds).toContain('unit');
  expect(kinds).toContain('history');
  expect(result.review.checks).toEqual([
    { id: '9:1', status: 'fixed', evidence: 'headの<=判定を確認' },
  ]);
  const input = preflight(plan).find((input) => input.task.kind === 'history')!;
  const value = response(input);
  value.checks = [{ id: '9:1', status: 'fixed', evidence: '' }];
  expect(() => validateTaskResult(value, plan, input.task)).toThrow(
    expect.objectContaining({
      reason: 'OUTPUT_INVALID',
      detail: { subcode: 'CHECK_RESULT_INVALID', missing: [] },
    }),
  );
});
it('39件のcoverageで欠落・重複・担当外IDを拒否し、順序だけの違いは許容する', () => {
  const plan = fixture();
  const input = preflight(plan)[0];
  const obligations = Array.from({ length: 39 }, (_, i) => i.toString(16).padStart(16, '0'));
  const task = { ...input.task, obligations };
  for (const coverage of [
    obligations.slice(1),
    [...obligations.slice(1), obligations[1]],
    [...obligations.slice(1), 'f'.repeat(16)],
  ]) {
    expect(() => validateTaskResult({ ...response(input), coverage }, plan, task)).toThrow(
      expect.objectContaining({
        reason: 'OUTPUT_INVALID',
        detail: expect.objectContaining({ subcode: 'COVERAGE_MISMATCH', missing: [] }),
      }),
    );
  }
  expect(
    validateTaskResult({ ...response(input), coverage: [...obligations].reverse() }, plan, task)
      .coverage,
  ).toHaveLength(39);
});
it('各作業の担当範囲と補助資料の役割を明示し、未確認事項の委譲を前提にしない', () => {
  const inputs = preflight(fixture());
  const unit = inputs.find((i) => i.task.kind === 'unit')!;
  expect(unit.prompt).toContain(
    'PR全体の影響評価や全呼び出し経路の網羅はこの作業の責務ではありません',
  );
  expect(unit.prompt).toContain('後続へ未確認事項を引き継ぐ仕組みはありません');
  expect(unit.prompt).toContain('担当範囲内の判断に不可欠な資料が不足する場合はincomplete');
});
it('CALLER不足の未完了は後続へ進めず、完了に補正しない', async () => {
  const calls: string[] = [];
  await expect(
    runPartitionReview(fixture(), async (input) => {
      calls.push(input.task.id);
      return {
        value: {
          ...response(input),
          status: 'incomplete',
          incomplete: { subcode: 'MISSING_CONTEXT', missing: ['CALLER'] },
        },
        usage: { input: 1, output: 1, total: 2 },
      };
    }),
  ).rejects.toMatchObject({
    reason: 'INCOMPLETE',
    detail: { subcode: 'MISSING_CONTEXT', missing: ['CALLER'] },
  });
  expect(calls).toEqual(['task-1']);
});
it('確認済み一覧は必須キーの集合として検証し、欠落・担当外・配列・falseを拒否する', async () => {
  const { validateTaskResponse } = await import('./partition-review.ts');
  const plan = fixture(),
    input = preflight(plan)[0];
  const coverage = Object.fromEntries(input.task.obligations.map((id) => [id, true]));
  expect(validateTaskResponse({ ...response(input), coverage }, plan, input.task).coverage).toEqual(
    input.task.obligations,
  );
  for (const value of [
    {},
    { ...coverage, forged: true },
    Object.fromEntries(input.task.obligations.map((id) => [id, false])),
    JSON.parse('["forged"]'),
  ])
    expect(() =>
      validateTaskResponse({ ...response(input), coverage: value }, plan, input.task),
    ).toThrow(expect.objectContaining({ reason: 'OUTPUT_INVALID' }));
});
it('履歴30件の最大長根拠を出力量で分割しSDK境界まで成功する', async () => {
  const { requestStructuredReview } = await import('./review.ts');
  const plan = fixture();
  const base = plan.metadata.base;
  const prior = Array.from({ length: 30 }, (_, i) => ({
    id: `${i + 1}:1`,
    head: base,
    base,
    priority: 'P2' as const,
    path: 'app.ts',
    line: 1,
    condition: `条件${i}`,
    impact: '影響',
    fix: '修正',
  }));
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree' ? `100644 blob ${'c'.repeat(40)}\tapp.ts\0` : 'export const value = 1;',
    [base, plan.metadata.head],
  );
  const historyPlan = planReview({ ...plan.metadata, priorFindings: prior }, index, []);
  const { taskSchema } = await import('./task-schema.ts');
  const { validateTaskResponse } = await import('./partition-review.ts');
  const inputs = preflight(historyPlan).filter((i) => i.task.kind === 'history');
  expect(inputs.length).toBeGreaterThan(1);
  expect(inputs.flatMap((i) => i.task.priorIds).sort()).toEqual(prior.map((p) => p.id).sort());
  for (const input of inputs) {
    const value = {
      ...response(input),
      summary: 'あ'.repeat(300),
      uncertainties: Array(3).fill('あ'.repeat(150)),
      coverage: Object.fromEntries(input.task.obligations.map((id) => [id, true])),
      checks: input.task.priorIds.map((id) => ({
        id,
        status: 'fixed' as const,
        evidence: 'あ'.repeat(500),
      })),
      checkSources: input.task.priorIds.map((id) => ({ id, sources: input.task.sources })),
    };
    const text = JSON.stringify(value);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(30000);
    const result = await requestStructuredReview<typeof value, TaskResult>(
      'test-token',
      'data',
      (v) => validateTaskResponse(v, historyPlan, input.task),
      async () =>
        Response.json({
          id: 'test',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text, annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      taskSchema(input.task),
    );
    expect(result.value.checks).toHaveLength(input.task.priorIds.length);
  }
});

it('実計数による入力トークン超過だけ担当IDを二分し、全対象を一度ずつ完了する', async () => {
  const { ReviewFailure } = await import('./failure.ts');
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const sources = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? ['one.ts', 'two.ts'].map((p, i) => `100644 blob ${String(i).repeat(40)}\t${p}\0`).join('')
        : 'export const v = 1;',
    [base, head],
  );
  const plan = planReview(
    { number: 1, base, head, lines: { 'one.ts': [1], 'two.ts': [1] } },
    sources,
    ['one.ts', 'two.ts'].map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new\n' })),
  );
  const covered: string[] = [];
  let attempts = 0;
  const result = await runPartitionReview(plan, async (input) => {
    attempts++;
    if (input.task.obligations.length > 1)
      throw new ReviewFailure('INPUT_TOKEN_LIMIT', '計数結果が超過');
    covered.push(...input.task.obligations);
    return { value: response(input), usage: { input: 100, output: 10, total: 110 } };
  });
  expect(attempts).toBeGreaterThan(plan.tasks.length);
  expect(covered.sort()).toEqual(plan.obligations.map((o) => o.id).sort());
  expect(new Set(covered).size).toBe(covered.length);
  expect(result.completed).toEqual(plan.tasks.map((t) => t.id));
  let calls = 0;
  await expect(
    runPartitionReview(plan, async () => {
      calls++;
      throw new ReviewFailure('COST_BUDGET_EXCEEDED', '費用不足');
    }),
  ).rejects.toMatchObject({ reason: 'COST_BUDGET_EXCEEDED' });
  expect(calls).toBe(1);
});

it('単一対象の必須文脈がトークン上限を超えても資料を落として成功させない', async () => {
  const { ReviewFailure } = await import('./failure.ts');
  await expect(
    runPartitionReview(fixture(), async () => {
      throw new ReviewFailure('INPUT_TOKEN_LIMIT', '入力超過');
    }),
  ).rejects.toMatchObject({ reason: 'INPUT_TOKEN_LIMIT' });
});

it('候補整理で提示していない別候補の原文を引用したら固定理由で拒否する', async () => {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? ['a.ts', 'b.ts'].map((p, i) => `100644 blob ${String(i).repeat(40)}\t${p}\0`).join('')
        : 'export const v = 1;',
    [base, head],
  );
  const plan = planReview(
    { number: 1, base, head, lines: { 'a.ts': [1], 'b.ts': [1] } },
    index,
    ['a.ts', 'b.ts'].map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new\n' })),
  );
  await expect(
    runPartitionReview(plan, async (input) => {
      const value = response(input);
      if (input.task.kind === 'unit') {
        value.findings = plan.sources.map((s) => ({
          priority: 'P2',
          path: s.path,
          line: 1,
          condition: s.path,
          impact: '影響',
          fix: '修正',
        }));
        value.evidence = plan.sources.map((s, finding) => ({
          finding,
          sources: [s.id],
          priorId: null,
        }));
      } else {
        const current = input.candidates.find((c) => c.id === input.task.candidateIds![0])!;
        const absent = plan.sources.find((source) => !input.task.sources.includes(source.id))!;
        expect(absent).toBeDefined();
        value.decisions = [
          {
            id: current.id,
            disposition: 'keep',
            duplicateOf: null,
            reason: '担当外の原文を混入',
            sources: [...current.sources, absent.id],
          },
        ];
      }
      return { value, usage: { input: 1, output: 1, total: 2 } };
    }),
  ).rejects.toMatchObject({ reason: 'OUTPUT_INVALID', message: '候補整理の根拠が不正です' });
});

it('独立した宣言を保持し、合計だけトークン上限を超える場合に分割完了する', async () => {
  const { ReviewFailure } = await import('./failure.ts');
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const content = 'export function first() { return 1; }\nexport function second() { return 2; }\n';
  const index = indexSources(
    (...args) => (args[0] === 'ls-tree' ? `100644 blob ${'c'.repeat(40)}\ta.ts\0` : content),
    [base, head],
  );
  expect(index.files[0].sources).toHaveLength(2);
  const plan = planReview({ number: 1, base, head, lines: { 'a.ts': [1, 2] } }, index, [
    { path: 'a.ts', patch: '@@ -1,2 +1,2 @@\n-old1\n-old2\n+new1\n+new2\n' },
  ]);
  const result = await runPartitionReview(plan, async (input) => {
    if (input.task.sources.length > 1) throw new ReviewFailure('INPUT_TOKEN_LIMIT', '分割');
    return { value: response(input), usage: { input: 1, output: 1, total: 2 } };
  });
  expect(result.completed).toEqual(plan.tasks.map((t) => t.id));
});

it('出力不足では同一枠を再送せず拡大し、単一担当でも回復する', async () => {
  const { ReviewFailure } = await import('./failure.ts');
  const { detail } = await import('./diagnostics.ts');
  const limits: number[] = [];
  const result = await runPartitionReview(fixture(), async (input) => {
    limits.push(input.outputLimit!);
    if (limits.length === 1)
      throw new ReviewFailure('INCOMPLETE', '出力不足', detail('TOKEN_LIMIT'));
    return { value: response(input), usage: { input: 10, output: 9000, total: 9010 } };
  });
  expect(limits).toHaveLength(2);
  expect(limits[1]).toBe(limits[0] * 2);
  expect(result.completed).toEqual(['task-1']);
});
it('単一担当が最大枠でも不足した場合は有限で終了する', async () => {
  const { ReviewFailure } = await import('./failure.ts');
  const { detail } = await import('./diagnostics.ts');
  const limits: number[] = [];
  await expect(
    runPartitionReview(fixture(), async (input) => {
      limits.push(input.outputLimit!);
      throw new ReviewFailure('INCOMPLETE', '出力不足', detail('TOKEN_LIMIT'));
    }),
  ).rejects.toMatchObject({ reason: 'INCOMPLETE' });
  expect(limits.at(-1)).toBe(128000);
  expect(new Set(limits).size).toBe(limits.length);
});

it('候補を順次確認し、保持候補との重複を双方の原文で確認できる', async () => {
  const base = 'b'.repeat(40),
    head = 'a'.repeat(40);
  const index = indexSources(
    (...args) =>
      args[0] === 'ls-tree'
        ? ['a.ts', 'b.ts'].map((p, i) => `100644 blob ${String(i).repeat(40)}\t${p}\0`).join('')
        : 'export const v = 1;',
    [base, head],
  );
  const plan = planReview(
    { number: 1, base, head, lines: { 'a.ts': [1], 'b.ts': [1] } },
    index,
    ['a.ts', 'b.ts'].map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new\n' })),
  );
  let comparisons = 0;
  const result = await runPartitionReview(plan, async (input) => {
    const value = response(input);
    if (input.task.kind === 'unit') {
      value.findings = plan.sources.map((s) => ({
        priority: 'P2',
        path: s.path,
        line: 1,
        condition: s.path,
        impact: '影響',
        fix: '修正',
      }));
      value.evidence = plan.sources.map((s, finding) => ({
        finding,
        sources: [s.id],
        priorId: null,
      }));
    } else {
      comparisons++;
      expect(input.task.candidateIds).toHaveLength(1);
      const current = input.candidates.find((c) => input.task.candidateIds!.includes(c.id))!;
      const other = input.candidates.find((c) => c.id !== current.id);
      const sources = [...current.sources, ...(other?.sources ?? [])];
      expect(sources.every((id) => input.task.sources.includes(id))).toBe(true);
      value.decisions = [
        {
          id: current.id,
          disposition: other ? 'duplicate' : 'keep',
          duplicateOf: other?.id ?? null,
          reason: '原文を比較',
          sources,
        },
      ];
    }
    return { value, usage: { input: 10, output: 20, total: 30 } };
  });
  expect(comparisons).toBe(2);
  expect(result.review.findings).toHaveLength(1);
});

it.each([false, true])(
  '最大出力でも不足する複数担当は分割し、最後の子が失敗したら結果を返さない: %s',
  async (failLast) => {
    const { ReviewFailure } = await import('./failure.ts');
    const { detail } = await import('./diagnostics.ts');
    const base = 'b'.repeat(40),
      head = 'a'.repeat(40);
    const index = indexSources(
      (...args) =>
        args[0] === 'ls-tree'
          ? `100644 blob ${'c'.repeat(40)}\ta.ts\0`
          : 'export function a() { return 1; }\nexport function b() { return 2; }\n',
      [base, head],
    );
    const plan = planReview({ number: 1, base, head, lines: { 'a.ts': [1, 2] } }, index, [
      { path: 'a.ts', patch: '@@ -1,2 +1,2 @@\n-old1\n-old2\n+new1\n+new2\n' },
    ]);
    const covered: string[] = [];
    let parents = 0;
    const run = runPartitionReview(plan, async (input) => {
      if (input.task.obligations.length > 1) {
        parents++;
        throw new ReviewFailure('INCOMPLETE', '不足', detail('TOKEN_LIMIT'));
      }
      if (failLast && covered.length) throw new ReviewFailure('MODEL_FAILED', '最後の子が失敗');
      covered.push(...input.task.obligations);
      return { value: response(input), usage: { input: 1, output: 1, total: 2 } };
    });
    if (failLast) await expect(run).rejects.toMatchObject({ reason: 'MODEL_FAILED' });
    else {
      expect((await run).completed).toEqual(plan.tasks.map((t) => t.id));
      expect(covered.sort()).toEqual(plan.obligations.map((o) => o.id).sort());
    }
    expect(parents).toBeGreaterThan(1);
  },
);
it.each(['CONTENT_FILTER', 'API_INCOMPLETE'] as const)(
  '出力不足以外の中断は再生成しない: %s',
  async (subcode) => {
    const { ReviewFailure } = await import('./failure.ts');
    const { detail } = await import('./diagnostics.ts');
    let calls = 0;
    await expect(
      runPartitionReview(fixture(), async () => {
        calls++;
        throw new ReviewFailure('INCOMPLETE', '中断', detail(subcode));
      }),
    ).rejects.toMatchObject({ reason: 'INCOMPLETE' });
    expect(calls).toBe(1);
  },
);
