import { parseJson, isRecord } from './json.ts';
import { readdir, readFile } from 'node:fs/promises';
import { globSync } from 'node:fs';
import path from 'node:path';
import { createVitest } from 'vitest/node';
import { selectTestFiles, validateTestFiles } from '../../local-integration/src/test-suites.ts';
import type { Test } from './types.ts';
const { resolve, relative } = path;
export async function inventory(root: string): Promise<Test[]> {
  const tests: Test[] = [];
  for (const parent of ['apps', 'packages', 'tools']) {
    for (const entry of await readdir(resolve(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const project = `${parent}/${entry.name}`;
      const manifest = await readFile(resolve(root, project, 'package.json'), 'utf8')
        .then((body) => parseJson(body))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            return null;
          }
          throw error;
        });
      if (manifest === null) {
        continue;
      }
      if (!isRecord(manifest)) {
        throw new Error(`package.jsonが不正です: ${project}`);
      }
      if (manifest.scripts === undefined) {
        continue;
      }
      if (!isRecord(manifest.scripts)) {
        throw new Error(`scriptsが不正です: ${project}`);
      }
      if (manifest.scripts.test === undefined) {
        continue;
      }
      if (typeof manifest.scripts.test !== 'string') {
        throw new TypeError(`test scriptが不正です: ${project}`);
      }
      if (manifest.scripts.test.startsWith('node --test ')) {
        const patterns = manifest.scripts.test.slice('node --test '.length).trim().split(/\s+/u);
        if (patterns.some((pattern) => !/^[-\w./*?]+\.[cm]?[jt]sx?$/u.test(pattern))) {
          throw new Error(`Node test指定を解析できません: ${project}`);
        }
        const files = globSync(patterns, { cwd: resolve(root, project) });
        if (files.length === 0) {
          throw new Error(`Node test検出が0件です: ${project}`);
        }
        for (const file of files) {
          const path = `${project}/${file}`;
          tests.push({
            id: `node:${project}:node-test:${path}`,
            file: path,
            project,
            suite: 'node-test',
            runnerClass: 'node',
          });
        }
        continue;
      }
      const runnerClass = parent === 'apps' ? 'worker' : 'node';
      const ctx = await createVitest({
        root: resolve(root, project),
        watch: false,
        maxWorkers: 2,
      });
      try {
        const specs = await ctx.globTestSpecifications();
        if (specs.length === 0) {
          throw new Error(`テスト検出が0件です: ${project}`);
        }
        const files = specs.map((spec) =>
          relative(resolve(root, project), spec.moduleId).replaceAll('\\', '/'),
        );
        if (project === 'tools/local-integration') {
          validateTestFiles(files);
        }
        for (const file of files) {
          if (project === 'tools/local-integration' && selectTestFiles('realtime').includes(file)) {
            continue;
          }
          const suite =
            project === 'tools/local-integration'
              ? selectTestFiles('boundary').includes(file)
                ? 'boundary'
                : 'integration-pr'
              : 'unit';
          const kind: Test['runnerClass'] =
            suite === 'boundary'
              ? 'boundary'
              : suite === 'integration-pr'
                ? 'integration'
                : runnerClass;
          const path = `${project}/${file}`;
          tests.push({
            id: `${kind}:${project}:${suite}:${path}`,
            file: path,
            project,
            suite,
            runnerClass: kind,
          });
        }
      } finally {
        await ctx.close();
      }
    }
  }
  tests.push({
    id: 'e2e:tools/e2e:pr:tools/e2e/run.mjs',
    file: 'tools/e2e/run.mjs',
    project: 'tools/e2e',
    suite: 'pr',
    runnerClass: 'e2e',
  });
  if (new Set(tests.map((test) => test.id)).size !== tests.length) {
    throw new Error('テストIDが重複しています。');
  }
  return tests.toSorted((a, b) => a.id.localeCompare(b.id));
}
