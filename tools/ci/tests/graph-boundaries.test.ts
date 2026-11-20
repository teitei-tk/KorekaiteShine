import { expect, test } from 'vitest';
import { affectedTests, buildGraph } from '../src/graph.ts';

test.each([
  ['packages/a/package.json', '{'],
  ['tools/a/tsconfig.json', '{'],
  ['tools/a/source.ts', 'const = broken'],
])('解析不能な入力では安全側へ全件選択する: %s', (file, body) => {
  const graph = buildGraph(
    new Map([
      [file, body],
      ['tools/a/a.test.ts', ''],
    ]),
  );
  expect(graph.unsafe).toBe(true);
  expect(
    affectedTests(graph, ['tools/a/a.test.ts'], ['tools/a/a.test.ts', 'tools/b/b.test.ts']),
  ).toHaveLength(2);
});
test('workspaceの文字列・条件付き・欠損exportsを区別する', () => {
  const graph = buildGraph(
    new Map([
      ['packages/string/package.json', '{"name":"string","exports":"./value.ts"}'],
      [
        'packages/conditional/package.json',
        '{"name":"conditional","exports":{".":{"import":"./import.ts","require":["./require.ts",null,1]},"./missing":null}}',
      ],
      ['packages/empty/package.json', '{"name":"empty"}'],
      ['packages/nameless/package.json', '{}'],
      [
        'tools/a/source.ts',
        "import 'string'; import 'conditional'; import 'conditional/missing'; import 'empty'; import 'external-package'",
      ],
    ]),
  );
  expect(graph.reverse.get('packages/string/value.ts')).toEqual(new Set(['tools/a/source.ts']));
  expect(graph.reverse.get('packages/conditional/import.ts')).toEqual(
    new Set(['tools/a/source.ts']),
  );
  expect(graph.reverse.get('packages/conditional/require.ts')).toEqual(
    new Set(['tools/a/source.ts']),
  );
  expect(graph.uncertain).toEqual(new Set(['tools/a/source.ts']));
});
test('型import・静的動的import・リテラル変数の依存を辿る', () => {
  const graph = buildGraph(
    new Map([
      ['tools/a/tsconfig.json', '{}'],
      ['tools/a/nested/tsconfig.json', '{"compilerOptions":{}}'],
      [
        'tools/a/nested/source.ts',
        "type T=import('./type').T; import('./dynamic'); const name='./bound'; import(name); let empty; const { a } = obj; import(missing); import(); export { local };",
      ],
      ['tools/a/nested/type.ts', 'export type T = string'],
      ['tools/a/nested/dynamic.ts', ''],
      ['tools/a/nested/bound.ts', ''],
    ]),
  );
  for (const dependency of ['type', 'dynamic', 'bound']) {
    expect(graph.reverse.get(`tools/a/nested/${dependency}.ts`)).toEqual(
      new Set(['tools/a/nested/source.ts']),
    );
  }
  expect(graph.uncertain.has('tools/a/nested/source.ts')).toBe(true);
});
test('生成契約とrouteTree、コード生成ツールの依存を保持する', () => {
  const graph = buildGraph(
    new Map([
      ['packages/api-contracts/src/value.ts', "import '../generated/schema'"],
      ['packages/api-contracts/http/main.tsp', ''],
      ['packages/api-contracts/tests/a.test.ts', ''],
      ['apps/web/src/router.ts', "import './routeTree.gen.ts'"],
      ['apps/web/vite.config.ts', ''],
      ['apps/web/router.config.ts', ''],
      ['apps/web/src/routes/index.ts', ''],
      ['tools/api-codegen/src/generate.ts', ''],
      ['tools/other/source.ts', "import '@/missing'; import '@korekaite/missing'"],
    ]),
  );
  expect(graph.reverse.get('packages/api-contracts/http/main.tsp')).toContain(
    'packages/api-contracts/generated/schema',
  );
  expect(graph.reverse.get('packages/api-contracts/http/main.tsp')).toContain(
    'tools/api-codegen/src/generate.ts',
  );
  expect(graph.reverse.get('packages/api-contracts/tests/a.test.ts')).not.toContain(
    'packages/api-contracts/generated/schema',
  );
  expect(graph.reverse.get('apps/web/vite.config.ts')).toContain('apps/web/src/routeTree.gen.ts');
  expect(graph.reverse.get('apps/web/router.config.ts')).toContain('apps/web/src/routeTree.gen.ts');
});
test('TypeScriptで解決しないassetも存在すれば依存へ含める', () => {
  const graph = buildGraph(
    new Map([
      ['tools/a/source.ts', "import './asset.css?inline'"],
      ['tools/a/asset.css', ''],
      ['tools/a/a.test.ts', ''],
      ['tools/b/b.test.ts', ''],
    ]),
  );
  expect(graph.reverse.get('tools/a/asset.css')).toContain('tools/a/source.ts');
  expect(
    affectedTests(graph, ['tools/a/asset.css'], ['tools/a/a.test.ts', 'tools/b/b.test.ts']),
  ).toEqual(['tools/a/a.test.ts']);
});
test('利用者がない既知の変更は無関係な検査を選ばない', () => {
  const graph = buildGraph(
    new Map([
      ['tools/a/unused.md', ''],
      ['tools/b/b.test.ts', ''],
    ]),
  );
  expect(affectedTests(graph, ['tools/a/unused.md'], ['tools/b/b.test.ts'])).toEqual([]);
});

test('外部パッケージのmanifestと実ファイルを解決する', () => {
  const graph = buildGraph(
    new Map([
      ['node_modules/external/package.json', '{"types":"index.d.ts"}'],
      ['node_modules/external/index.d.ts', 'export const value: string'],
      ['tools/a/source.ts', "import { value } from 'external'"],
    ]),
  );
  expect(graph.reverse.get('node_modules/external/index.d.ts')).toContain('tools/a/source.ts');
});
