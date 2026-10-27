import { expect, it } from 'vitest';
import { indexSources } from './source-index.ts';
import { planReview, validatePlan } from './partition.ts';
import type { Material } from './material.ts';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const metadata: Material = { number: 12, head, base, lines: { 'app.ts': [2] }, priorFindings: [] };
function index(files: Record<string, string>) {
  const entries = Object.keys(files).map((path, i) => ({
    path,
    blob: i.toString(16).padStart(40, '0'),
  }));
  return indexSources(
    (...args) => {
      if (args[0] === 'ls-tree')
        return entries.map((e) => `100644 blob ${e.blob}\t${e.path}\0`).join('');
      return files[entries.find((e) => e.blob === args[2])!.path];
    },
    [base, head],
  );
}
const patch = {
  path: 'app.ts',
  patch: '@@ -1,2 +1,2 @@\n import { value } from "./value.ts";\n-old\n+new\n',
};

it('無関係なファイルを送信せず参照関係の両側を横断確認する', () => {
  const sources = index({
    'app.ts': 'import { value } from "./value.ts";\nexport const app = value;',
    'value.ts': 'export const value = 1;',
    'unrelated.ts': 'export const secret = 2;',
  });
  const plan = planReview(metadata, sources, [patch]);
  expect(plan.sources.some((s) => s.path === 'unrelated.ts')).toBe(false);
  const boundary = plan.tasks.find((t) => t.kind === 'boundary')!;
  expect(boundary).toBeDefined();
  expect(
    new Set(boundary.sources.map((id) => plan.sources.find((s) => s.id === id)!.path)),
  ).toEqual(new Set(['app.ts', 'value.ts']));
  expect(() => validatePlan(plan)).not.toThrow();
});
it('全体が300KB超でも各入力を上限内へ分割する', () => {
  const files = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `f${i}.ts`,
      `export const value = '${'x'.repeat(48000)}';\n`,
    ]),
  );
  const patches = Object.keys(files).map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new\n' }));
  const plan = planReview(
    { ...metadata, lines: Object.fromEntries(Object.keys(files).map((p) => [p, [1]])) },
    index(files),
    patches,
  );
  expect(plan.tasks.filter((t) => t.kind === 'unit').length).toBeGreaterThan(0);
  expect(plan.sources.reduce((n, s) => n + Buffer.byteLength(s.content), 0)).toBeGreaterThan(
    300000,
  );
  expect(() => validatePlan(plan)).not.toThrow();
});
it('関連する動的importを見落とさず未完了で停止する', () => {
  expect(() =>
    planReview(metadata, index({ 'app.ts': 'const file = "a";\nimport(file);' }), [patch]),
  ).toThrow(/未解決/);
});
it('循環参照を有限の境界として扱い、担当対象の欠落を拒否する', () => {
  const plan = planReview(
    metadata,
    index({
      'app.ts': 'import "./value.ts";\nexport const a = 1;',
      'value.ts': 'import "./app.ts";',
    }),
    [patch],
  );
  plan.tasks[0].obligations = [];
  expect(() => validatePlan(plan)).toThrow();
});
it('巨大な単一宣言を切り捨てず計数対象へ渡す', () => {
  expect(() =>
    planReview(metadata, index({ 'app.ts': `export const a = '${'x'.repeat(310000)}';` }), [patch]),
  ).not.toThrow();
});
it('変更されていない過去指摘も独立した確認対象に含める', () => {
  const prior = {
    id: '9:0',
    head: base,
    base,
    priority: 'P2' as const,
    path: 'old.ts',
    line: 1,
    condition: '条件',
    impact: '影響',
    fix: '修正',
  };
  const plan = planReview(
    { ...metadata, priorFindings: [prior] },
    index({ 'app.ts': 'export const a = 1;', 'old.ts': 'export const old = 1;' }),
    [{ path: 'app.ts', patch: '@@ -1 +1 @@\n-a\n+b\n' }],
  );
  expect(plan.tasks.filter((t) => t.kind === 'history').flatMap((t) => t.priorIds)).toEqual([
    '9:0',
  ]);
  expect(plan.sources.some((s) => s.path === 'old.ts')).toBe(true);
});
it('存在しない静的参照と索引上限超過を拒否する', () => {
  expect(() =>
    planReview(metadata, index({ 'app.ts': 'import "./missing.ts";' }), [patch]),
  ).toThrow(/未解決/);
  expect(() =>
    indexSources(() => '100644 blob ' + 'c'.repeat(40) + '\tx.ts\0', [base], {
      files: 0,
    }),
  ).toThrow(/索引/);
});
it('文書の除外資料へのリンクは理由を残し、存在しない参照とは区別する', () => {
  const sources = index({
    'app.md': '[lock](./pnpm-lock.yaml)',
    'pnpm-lock.yaml': 'lockfileVersion: 9',
  });
  const plan = planReview({ ...metadata, lines: { 'app.md': [1] } }, sources, [
    { path: 'app.md', patch: '@@ -1 +1 @@\n-old\n+new\n' },
  ]);
  expect(plan.excluded).toContain('pnpm-lock.yaml');
});
it('巨大な一つのhunkを宣言境界で分割し、変更行を落とさない', () => {
  const content = Array.from(
    { length: 12 },
    (_, i) => `export const v${i} = '${'x'.repeat(30000)}';\n`,
  ).join('');
  const plan = planReview(
    { ...metadata, lines: { 'app.ts': Array.from({ length: 12 }, (_, i) => i + 1) } },
    index({ 'app.ts': content }),
    [
      {
        path: 'app.ts',
        patch:
          '@@ -0,0 +1,12 @@\n' +
          content
            .trimEnd()
            .split('\n')
            .map((line) => '+' + line)
            .join('\n') +
          '\n',
      },
    ],
  );
  expect(plan.tasks.length).toBeGreaterThan(0);
  expect(
    plan.obligations
      .filter((o) => o.patch)
      .map((o) => o.patch!.patch)
      .join(''),
  ).toContain('v11');
});
it('未解決のbare aliasは外部依存として無視しない', () => {
  expect(() =>
    planReview(metadata, index({ 'app.ts': 'import {x} from "#internal";' }), [patch]),
  ).toThrow(/未解決/);
});
it('package scriptの相対スクリプトを関連資料として含める', () => {
  const sources = index({
    'package.json': '{"scripts":{"check":"node ./check.ts"}}',
    'check.ts': 'export const x = 1;',
  });
  const plan = planReview({ ...metadata, lines: { 'package.json': [1] } }, sources, [
    { path: 'package.json', patch: '@@ -1 +1 @@\n-old\n+new\n' },
  ]);
  expect(plan.sources.some((s) => s.path === 'check.ts')).toBe(true);
});
it.each([
  'export type T = import("./contract.ts").T;',
  'import contract = require("./contract.ts");',
])('型参照とimport-equalsの境界を含める: %s', (content) => {
  const plan = planReview(
    metadata,
    index({ 'app.ts': content, 'contract.ts': 'export type T = string;' }),
    [patch],
  );
  expect(plan.sources.some((s) => s.path === 'contract.ts')).toBe(true);
  expect(plan.tasks.some((t) => t.kind === 'boundary')).toBe(true);
});
it.each(['build', 'lint', 'run build'])('Workflowからpackage scriptと実装を追う: %s', (command) => {
  const path = '.github/workflows/build.yml';
  const plan = planReview(
    { ...metadata, lines: { [path]: [1] } },
    index({
      [path]: `steps:\n  - run: pnpm ${command}\n`,
      'package.json': '{"scripts":{"build":"node ./build.ts","lint":"node ./build.ts"}}',
      'build.ts': 'export const build = true;',
    }),
    [{ path, patch: '@@ -1 +1 @@\n-old\n+new\n' }],
  );
  expect(plan.sources.some((s) => s.path === 'package.json')).toBe(true);
  expect(plan.sources.some((s) => s.path === 'build.ts')).toBe(true);
});
it('Workflowの動的なscript呼び出しを黙って省略しない', () => {
  const path = '.github/workflows/build.yml';
  expect(() =>
    planReview(
      { ...metadata, lines: { [path]: [1] } },
      index({ [path]: 'steps:\n  - run: pnpm $SCRIPT\n', 'package.json': '{}' }),
      [{ path, patch: '@@ -1 +1 @@\n-old\n+new\n' }],
    ),
  ).toThrow(/未解決/);
});
it.each([
  '[contract][api]\n\n[api]: ./contract.md',
  '[API][]\n\n[api]: <./contract.md> "仕様"',
  '[api]\n\n[API]:\n  ./contract.md',
])('参照形式リンクを横断確認に含める: %s', (content) => {
  const path = 'guide.md';
  const plan = planReview(
    { ...metadata, lines: { [path]: [1] } },
    index({ [path]: content, 'contract.md': '# 契約\n入力は整数です。' }),
    [{ path, patch: '@@ -1 +1 @@\n-old\n+new\n' }],
  );
  expect(plan.sources.some((s) => s.path === 'contract.md')).toBe(true);
  expect(plan.tasks.some((t) => t.kind === 'boundary')).toBe(true);
});
it('参照形式のリンク先が存在しなければ停止する', () => {
  expect(() =>
    planReview(
      { ...metadata, lines: { 'guide.md': [1] } },
      index({ 'guide.md': '[contract][api]\n\n[api]: ./missing.md' }),
      [{ path: 'guide.md', patch: '@@ -1 +1 @@\n-old\n+new\n' }],
    ),
  ).toThrow(/未解決/);
});
it('コード例と未使用のリンク定義は関連資料へ含めない', () => {
  const plan = planReview(
    { ...metadata, lines: { 'guide.md': [1] } },
    index({
      'guide.md': '`[example][missing]`\n\n```md\n[x](./absent.md)\n```\n\n[unused]: ./absent.md',
    }),
    [{ path: 'guide.md', patch: '@@ -1 +1 @@\n-old\n+new\n' }],
  );
  expect(plan.sources.map((s) => s.path)).toEqual(['guide.md']);
});

it('単位作業にも直接の呼び出し元・依存先・規約を補助資料として渡す', () => {
  const plan = planReview(
    metadata,
    index({
      'app.ts': 'import { value } from "./value.ts";\nexport const app = value;',
      'value.ts': 'export const value = 1;',
      'caller.ts': 'import { app } from "./app.ts";\nexport const result = app;',
      'AGENTS.md': '# 規約\nテストで検証する。',
      'unrelated.ts': 'export const unrelated = 1;',
    }),
    [patch],
  );
  const unit = plan.tasks.find((t) => t.kind === 'unit')!;
  const paths = unit.sources.map((id) => plan.sources.find((s) => s.id === id)!.path);
  expect(paths).toEqual(expect.arrayContaining(['app.ts', 'value.ts', 'caller.ts', 'AGENTS.md']));
  expect(paths).not.toContain('unrelated.ts');
  const caller = plan.sources.find((s) => s.path === 'caller.ts')!.id;
  expect(
    plan.obligations.filter((o) => o.kind === 'unit').every((o) => o.context.includes(caller)),
  ).toBe(true);
  unit.sources = unit.sources.filter((id) => id !== caller);
  expect(() => validatePlan(plan)).toThrow('担当対象');
});
it('補助資料の共有依存から無関係な利用側へ再帰展開しない', () => {
  const plan = planReview(
    metadata,
    index({
      'app.ts': 'import { value } from "./value.ts";\nexport const app = value;',
      'value.ts': 'export const value = 1;',
      'other.ts': 'import { value } from "./value.ts";\nexport const other = value;',
    }),
    [patch],
  );
  expect(plan.sources.some((s) => s.path === 'other.ts')).toBe(false);
});
it('補助資料の台帳からの削除や不正IDをハッシュ検証で拒否する', () => {
  const plan = planReview(
    metadata,
    index({
      'app.ts': 'import { value } from "./value.ts";',
      'value.ts': 'export const value = 1;',
    }),
    [patch],
  );
  const target = plan.obligations.find((o) => o.kind === 'unit')!;
  const saved = target.context;
  target.context = [];
  expect(() => validatePlan(plan)).toThrow('確認対象');
  target.context = [...saved, 'invalid'];
  expect(() => validatePlan(plan)).toThrow('確認対象');
});
it('補助資料が旧容量上限を超えても切り捨てず計数対象に含める', () => {
  const files: Record<string, string> = {};
  for (const prefix of ['a', 'b']) {
    const refs = Array.from({ length: 4 }, (_, i) => `${prefix}${i}.ts`);
    files[`${prefix}.ts`] = refs
      .map((p, i) => `import { value as v${i} } from './${p}';`)
      .join('\n');
    for (const path of refs) files[path] = `export const value = '${'x'.repeat(48000)}';`;
  }
  const patches = ['a.ts', 'b.ts'].map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new\n' }));
  const plan = planReview(
    { ...metadata, lines: { 'a.ts': [1], 'b.ts': [1] } },
    index(files),
    patches,
  );
  expect(plan.tasks.filter((t) => t.kind === 'unit')).toHaveLength(1);
  files['a.ts'] +=
    '\n' +
    Array.from({ length: 4 }, (_, i) => `import { value as b${i} } from './b${i}.ts';`).join('\n');
  expect(() => planReview(metadata, index(files), patches)).not.toThrow();
});
it('PR30型のCLI変更では単位作業にpackage呼び出し・依存先・領域仕様を同梱する', () => {
  const files = {
    'tools/ai-review/check-run.ts':
      "import { version } from './run-version.ts';\nexport const run = version;",
    'tools/ai-review/run-version.ts':
      "import { repository } from './policy.ts';\nexport const version = repository;",
    'tools/ai-review/policy.ts': "export const repository = 'example';",
    'package.json': JSON.stringify({
      scripts: { 'check:ai-run': 'node tools/ai-review/check-run.ts' },
    }),
    'AGENTS.md': '# 作業規約',
    'CODING_STANDARDS.md': '# コード規約',
    'GLOSSARY.md': '# 用語',
    'docs/spec/ai-review.md': '# レビュー仕様',
    'docs/spec/ai-review-partitioning.md': '# 分割仕様',
  };
  const paths = ['tools/ai-review/check-run.ts', 'tools/ai-review/run-version.ts'];
  const plan = planReview(
    { ...metadata, lines: Object.fromEntries(paths.map((p) => [p, [1]])) },
    index(files),
    paths.map((path) => ({ path, patch: '@@ -1 +1 @@\n-old\n+new\n' })),
  );
  for (const task of plan.tasks.filter((t) => t.kind === 'unit')) {
    const materials = task.sources.map((id) => plan.sources.find((s) => s.id === id)!.path);
    expect(materials).toEqual(
      expect.arrayContaining([
        'package.json',
        'tools/ai-review/policy.ts',
        'AGENTS.md',
        'CODING_STANDARDS.md',
        'docs/spec/ai-review.md',
        'docs/spec/ai-review-partitioning.md',
      ]),
    );
  }
});
