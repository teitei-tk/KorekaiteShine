import { expect, test } from 'vitest';
import { buildGraph, affectedTests, mergeGraphs } from '../src/graph.ts';

test('削除前の辺とaliasを辿ってテストへ到達する', () => {
  const old = buildGraph(
    new Map([
      ['tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}'],
      ['src/deleted.ts', 'export const a=1'],
      ['src/current.ts', "export {a} from '@/deleted'"],
      ['tests/a.test.ts', "import '../src/current'"],
    ]),
  );
  const current = buildGraph(
    new Map([
      ['src/current.ts', 'export const a=1'],
      ['tests/a.test.ts', "import '../src/current'"],
    ]),
  );
  expect(
    affectedTests(mergeGraphs(old, current), ['src/deleted.ts'], ['tests/a.test.ts']),
  ).toStrictEqual(['tests/a.test.ts']);
});

test('不明変更は全件、空変更は空になる', () => {
  const graph = buildGraph(new Map([['tests/a.test.ts', '']]));
  expect(affectedTests(graph, ['unknown.xyz'], ['tests/a.test.ts'])).toStrictEqual([
    'tests/a.test.ts',
  ]);
  expect(affectedTests(graph, [], ['tests/a.test.ts'])).toStrictEqual([]);
});

test('DB SQL、契約、Worker越境は保守的に関連検査へ伝わる', () => {
  const graph = buildGraph(
    new Map([
      ['packages/database/migrations/a.sql', 'select 1'],
      ['packages/api-contracts/http/main.tsp', ''],
      ['apps/interview/src/a.ts', ''],
      ['apps/web/tests/a.test.ts', ''],
      ['tools/local-integration/tests/b.test.ts', ''],
      ['tools/e2e/run.mjs', ''],
    ]),
  );
  for (const path of [
    'packages/database/migrations/a.sql',
    'packages/api-contracts/http/main.tsp',
    'apps/interview/src/a.ts',
  ]) {
    expect(
      affectedTests(
        graph,
        [path],
        [
          'apps/web/tests/a.test.ts',
          'tools/local-integration/tests/b.test.ts',
          'tools/e2e/run.mjs',
        ],
      ),
    ).toHaveLength(path.startsWith('apps/interview/') ? 2 : 3);
  }
});

test('解決したaliasは無関係な領域を選択しない', () => {
  const graph = buildGraph(
    new Map([
      ['apps/a/tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}'],
      ['apps/a/src/value.ts', 'export const value=1'],
      ['apps/a/tests/a.test.ts', "import '@/value'"],
      ['tools/docs/tests/b.test.ts', ''],
    ]),
  );
  expect(graph.unsafe).toBeFalsy();
  expect(
    affectedTests(
      graph,
      ['apps/a/src/value.ts'],
      ['apps/a/tests/a.test.ts', 'tools/docs/tests/b.test.ts'],
    ),
  ).toStrictEqual(['apps/a/tests/a.test.ts']);
});

test('workspace exportsを解決し、設定変更は全件へ戻る', () => {
  const graph = buildGraph(
    new Map([
      [
        'packages/util/package.json',
        '{"name":"@korekaite/util","exports":{"./value":"./src/value.ts"}}',
      ],
      ['packages/util/src/value.ts', 'export const value=1'],
      ['tools/a/tests/a.test.ts', "import '@korekaite/util/value'"],
      ['tools/b/tests/b.test.ts', ''],
    ]),
  );
  expect(graph.unsafe).toBeFalsy();
  expect(
    affectedTests(
      graph,
      ['packages/util/src/value.ts'],
      ['tools/a/tests/a.test.ts', 'tools/b/tests/b.test.ts'],
    ),
  ).toStrictEqual(['tools/a/tests/a.test.ts']);
  expect(
    affectedTests(
      graph,
      ['pnpm-lock.yaml'],
      ['tools/a/tests/a.test.ts', 'tools/b/tests/b.test.ts'],
    ),
  ).toHaveLength(2);
});

test('解析不能の動的依存の利用領域を常に選択する', () => {
  const graph = buildGraph(
    new Map([
      ['tools/a/src/a.ts', 'import(variable)'],
      ['tools/a/tests/a.test.ts', ''],
    ]),
  );
  expect(affectedTests(graph, ['tools/a/src/a.ts'], ['tools/a/tests/a.test.ts'])).toStrictEqual([
    'tools/a/tests/a.test.ts',
  ]);
});
test('未解決importは利用側へ保守的に伝え、無関係領域は選択しない', () => {
  const graph = buildGraph(
    new Map([
      ['tools/a/src/a.ts', "import '../generated/missing'"],
      ['tools/a/tests/a.test.ts', "import '../src/a'"],
      ['tools/b/tests/b.test.ts', ''],
    ]),
  );
  expect(
    affectedTests(
      graph,
      ['tools/b/tests/b.test.ts'],
      ['tools/a/tests/a.test.ts', 'tools/b/tests/b.test.ts'],
    ),
  ).toStrictEqual(['tools/a/tests/a.test.ts', 'tools/b/tests/b.test.ts']);
  expect(
    affectedTests(
      graph,
      ['tools/a/src/a.ts'],
      ['tools/a/tests/a.test.ts', 'tools/b/tests/b.test.ts'],
    ),
  ).toStrictEqual(['tools/a/tests/a.test.ts']);
});
test('Worker変更は接続検査へ伝わるが別Worker単体へ逆流しない', () => {
  const graph = buildGraph(
    new Map([
      ['apps/interview/src/a.ts', ''],
      ['apps/web/tests/a.test.ts', ''],
      ['tools/local-integration/tests/a.test.ts', ''],
      ['tools/e2e/run.mjs', ''],
      ['tools/coverage/tests/a.test.ts', ''],
    ]),
  );
  expect(
    affectedTests(
      graph,
      ['apps/interview/src/a.ts'],
      [
        'apps/web/tests/a.test.ts',
        'tools/local-integration/tests/a.test.ts',
        'tools/e2e/run.mjs',
        'tools/coverage/tests/a.test.ts',
      ],
    ),
  ).toStrictEqual(['tools/e2e/run.mjs', 'tools/local-integration/tests/a.test.ts']);
});
test('routeTreeとquery付き静的依存は既知の生成・asset依存として解決する', () => {
  const graph = buildGraph(
    new Map([
      ['apps/web/src/router.tsx', "import './routeTree.gen';import './audio.js?url'"],
      ['apps/web/src/routes/a.tsx', ''],
      ['apps/web/src/audio.js', ''],
      ['apps/web/tests/a.test.ts', ''],
    ]),
  );
  expect(graph.uncertain.size).toBe(0);
  expect(
    affectedTests(graph, ['apps/web/src/routes/a.tsx'], ['apps/web/tests/a.test.ts']),
  ).toStrictEqual(['apps/web/tests/a.test.ts']);
});

test('Cucumberのfeatureとsteps変更はPR E2Eを選ぶ', () => {
  const graph = buildGraph(
    new Map([
      ['tools/e2e/run.mjs', ''],
      ['tools/e2e/steps.mjs', ''],
      ['tools/e2e/features/voice.feature', 'Feature: voice'],
      ['tools/docs/check.test.ts', ''],
    ]),
  );
  for (const changed of ['tools/e2e/steps.mjs', 'tools/e2e/features/voice.feature']) {
    expect(
      affectedTests(graph, [changed], ['tools/e2e/run.mjs', 'tools/docs/check.test.ts']),
    ).toStrictEqual(['tools/e2e/run.mjs']);
  }
});

test('pnpmフックとrootの検査設定変更は全件実行へ拡大する', () => {
  const tests = ['tools/a/a.test.ts', 'apps/web/a.test.ts'];
  for (const file of ['.pnpmfile.cjs', '.oxlintrc.json']) {
    const graph = buildGraph(
      new Map([[file, ''], ...tests.map((file) => [file, ''] as [string, string])]),
    );
    expect(affectedTests(graph, [file], tests)).toStrictEqual([...tests].toSorted());
  }
});
