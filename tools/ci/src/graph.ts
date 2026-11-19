import { parseJson, isRecord } from './json.ts';
import type { JsonValue } from './json.ts';
import ts from 'typescript-compiler-api';
import path from 'node:path';
const { posix } = path;
export type Graph = {
  reverse: Map<string, Set<string>>;
  nodes: Set<string>;
  unsafe: boolean;
  uncertain: Set<string>;
};
const sourcePattern = /\.[cm]?[jt]sx?$/u;
const globalPattern =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*|vitest[^/]*|vite\.config[^/]*|wrangler[^/]*|void\.config[^/]*)$|^\.github\/|^tools\/ci\/|^docs\//u;
const runtimePattern = /^(?:apps\/|packages\/(?:database|api-contracts|runtime-config)\/)/u;
export function buildGraph(files: Map<string, string>): Graph {
  const graph: Graph = {
    reverse: new Map(),
    nodes: new Set(files.keys()),
    unsafe: false,
    uncertain: new Set(),
  };
  const edge = (user: string, dependency: string) => {
    const values = graph.reverse.get(dependency) ?? new Set<string>();
    values.add(user);
    graph.reverse.set(dependency, values);
  };
  const configs = new Map<string, ts.CompilerOptions>();
  const workspace = new Map<
    string,
    { directory: string; exports: string | Record<string, JsonValue | undefined> }
  >();
  for (const [file, body] of files) {
    if (file.endsWith('/package.json')) {
      try {
        const manifest = parseJson(body);
        if (isRecord(manifest) && typeof manifest.name === 'string') {
          workspace.set(manifest.name, {
            directory: posix.dirname(file),
            exports:
              typeof manifest.exports === 'string' ||
              (manifest.exports !== undefined && isRecord(manifest.exports))
                ? manifest.exports
                : {},
          });
        }
      } catch {
        graph.unsafe = true;
      }
    }
  }

  for (const [file, body] of files) {
    if (/(?:^|\/)tsconfig\.json$/u.test(file)) {
      const parsed = ts.parseConfigFileTextToJson(file, body);
      if (parsed.error) {
        graph.unsafe = true;
        continue;
      }
      const converted = ts.convertCompilerOptionsFromJson(
        (() => {
          const config = parseJson(JSON.stringify(parsed.config));
          return isRecord(config) && isRecord(config.compilerOptions) ? config.compilerOptions : {};
        })(),
        posix.dirname(file),
      );
      configs.set(posix.dirname(file), converted.options);
    }
  }
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => files.has(posix.normalize(path).replace(/^\.\//u, '')),
    readFile: (path) => files.get(posix.normalize(path).replace(/^\.\//u, '')),
    directoryExists: () => true,
    getCurrentDirectory: () => '.',
    realpath: (path) => path,
  };
  for (const [file, body] of files) {
    if (!sourcePattern.test(file)) {
      continue;
    }
    const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
    if (
      (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics
        ?.length
    ) {
      graph.unsafe = true;
    }
    const options =
      [...configs]
        .filter(([dir]) => dir === '.' || file.startsWith(`${dir}/`))
        .toSorted(([a], [b]) => b.length - a.length)[0]?.[1] ?? {};
    const add = (rawSpecifier: string) => {
      const specifier = rawSpecifier.slice(
        0,
        rawSpecifier.includes('?') ? rawSpecifier.indexOf('?') : rawSpecifier.length,
      );

      const entry = [...workspace].find(
        ([name]) => specifier === name || specifier.startsWith(`${name}/`),
      );
      if (entry) {
        const [name, manifest] = entry;
        const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
        const value =
          typeof manifest.exports === 'string' ? manifest.exports : manifest.exports[subpath];
        const targets = (value: JsonValue | undefined): string[] =>
          typeof value === 'string'
            ? [value]
            : value !== null && value !== undefined && typeof value === 'object'
              ? Object.values(value).flatMap((value) => targets(value))
              : [];
        const resolved = targets(value).map((target) =>
          posix.normalize(posix.join(manifest.directory, target)),
        );
        if (resolved.length > 0) {
          for (const target of resolved) {
            edge(file, target);
            graph.nodes.add(target);
          }
          return;
        }
        graph.uncertain.add(file);
        return;
      }

      const resolved = ts.resolveModuleName(
        specifier,
        file,
        { ...options, moduleResolution: ts.ModuleResolutionKind.Bundler },
        host,
      ).resolvedModule?.resolvedFileName;
      if (resolved && files.has(resolved)) {
        edge(file, resolved);
        return;
      }
      if (
        specifier.startsWith('.') ||
        specifier.startsWith('@/') ||
        specifier.startsWith('@korekaite/')
      ) {
        const base = posix.normalize(posix.join(posix.dirname(file), specifier));
        const target = [
          base,
          ...['.ts', '.tsx', '.js', '/index.ts', '/index.tsx'].map((ext) => base + ext),
        ].find((candidate) => files.has(candidate));
        if (target) {
          edge(file, target);
        } else if (base.includes('/generated/') && file.startsWith('packages/api-contracts/')) {
          graph.nodes.add(base);
          edge(file, base);
          for (const dependency of files.keys()) {
            if (
              dependency.startsWith('packages/api-contracts/') &&
              !dependency.includes('/tests/')
            ) {
              edge(base, dependency);
            }
          }
        } else if (base.endsWith('/routeTree.gen') || base.endsWith('/routeTree.gen.ts')) {
          graph.nodes.add(base);
          edge(file, base);
          for (const dependency of files.keys()) {
            if (
              dependency.startsWith('apps/web/src/routes/') ||
              /^apps\/web\/(?:vite|router)\./u.test(dependency)
            ) {
              edge(base, dependency);
            }
          }
        } else {
          graph.uncertain.add(file);
        }
      }
    };
    const literalBindings = new Map<string, string>();
    const collect = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        literalBindings.set(node.name.text, node.initializer.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        add(node.moduleSpecifier.text);
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        add(node.argument.literal.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments.at(0);
        if (argument && ts.isStringLiteralLike(argument)) {
          add(argument.text);
        } else {
          const binding =
            argument && ts.isIdentifier(argument) ? literalBindings.get(argument.text) : undefined;
          if (binding === undefined) {
            graph.uncertain.add(file);
          } else {
            add(binding);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // HTTP・Queue・D1の利用側から依存先へだけ辺を張る。
  const runtime = [...files.keys()].filter((file) => runtimePattern.test(file));
  const shared = runtime.filter(
    (file) => file.startsWith('packages/') && !file.includes('/tests/'),
  );
  for (const file of files.keys()) {
    if (/^tools\/(?:local-integration|e2e)\//u.test(file)) {
      for (const dependency of runtime) {
        edge(file, dependency);
      }
    }
    if (file.startsWith('apps/')) {
      for (const dependency of shared) {
        edge(file, dependency);
      }
    }
    if (file.startsWith('tools/api-codegen/')) {
      for (const dependency of files.keys()) {
        if (dependency.startsWith('packages/api-contracts/') && !dependency.includes('/tests/')) {
          edge(file, dependency);
        }
      }
    }
  }
  // 任意のファイル読込みと共有補助の未知依存を落とさない領域内の保守的な辺。
  const regions = new Map<string, string[]>();
  for (const path of files.keys()) {
    const region = path.split('/').slice(0, 2).join('/');
    const members = regions.get(region) ?? [];
    members.push(path);
    regions.set(region, members);
  }
  for (const members of regions.values()) {
    const tests = members.filter(
      (path) => path === 'tools/e2e/run.mjs' || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path),
    );
    for (const test of tests) {
      for (const dependency of members) {
        edge(test, dependency);
      }
    }
  }
  return graph;
}
export function mergeGraphs(...graphs: Graph[]): Graph {
  const result: Graph = {
    nodes: new Set(),
    reverse: new Map(),
    unsafe: graphs.some((graph) => graph.unsafe),
    uncertain: new Set(graphs.flatMap((graph) => [...graph.uncertain])),
  };
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      result.nodes.add(node);
    }
    for (const [dependency, users] of graph.reverse) {
      const target = result.reverse.get(dependency) ?? new Set<string>();
      for (const user of users) {
        target.add(user);
      }
      result.reverse.set(dependency, target);
    }
  }
  return result;
}
export function affectedTests(
  graph: Graph,
  changed: readonly string[],
  tests: readonly string[],
): string[] {
  if (changed.length === 0) {
    return [];
  }
  if (
    graph.unsafe ||
    changed.some(
      (path) => !path.includes('/') || globalPattern.test(path) || !graph.nodes.has(path),
    )
  ) {
    return [...tests].toSorted();
  }
  const seen = new Set([...changed, ...graph.uncertain]);
  const queue = [...seen];
  for (const node of queue) {
    for (const user of graph.reverse.get(node) ?? []) {
      if (!seen.has(user)) {
        seen.add(user);
        queue.push(user);
      }
    }
  }
  return tests.filter((test) => seen.has(test)).toSorted();
}
