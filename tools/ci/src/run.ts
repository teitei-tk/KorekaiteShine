import { isScenarioLocation } from '../../e2e/location.ts';
import path from 'node:path';

import { spawn } from 'node:child_process';
import { createVitest } from 'vitest/node';
import { identity } from './types.ts';
import type { Plan, Result, Shard } from './types.ts';
export function exactSpecifications<T extends { moduleId: string }>(
  specifications: T[],
  files: readonly string[],
): T[] {
  if (new Set(files).size !== files.length) {
    throw new Error('実行対象が重複しています。');
  }
  const selected = specifications.filter((spec) => files.includes(spec.moduleId));
  if (
    selected.length !== files.length ||
    files.some((file) => !selected.some((spec) => spec.moduleId === file))
  ) {
    throw new Error('実際のテスト一覧と実行計画が一致しません。');
  }
  return selected;
}
export { validateResults } from './results.ts';
export async function runShard(root: string, plan: Plan, shard: Shard): Promise<Result> {
  const started = performance.now();
  const result: Result = {
    schema: 1,
    sha: plan.sha,
    inventoryHash: plan.inventoryHash,
    shardId: shard.id,
    status: 'failed',
    executed: [],
    durations: {},
    elapsedMs: 0,
    timings: { prepareMs: 0, collectMs: 0, runMs: 0, teardownMs: 0 },
    fileTimings: {},
    identity: identity(shard.runnerClass),
  };
  try {
    const tests = shard.tests.map((id) => {
      const test = plan.tests.find((candidate) => candidate.id === id);
      if (!test) {
        throw new Error(`不明なテスト: ${id}`);
      }
      return test;
    });
    const projects = [...new Set(tests.map((test) => test.project))].toSorted();
    for (const project of projects) {
      const group = tests.filter((test) => test.project === project);
      if (group[0]?.suite === 'node-test') {
        for (const test of group) {
          const started = performance.now();
          const status = await new Promise<number>((resolve, reject) => {
            const child = spawn(process.execPath, ['--test', path.resolve(root, test.file)], {
              cwd: path.resolve(root, project),
              stdio: 'inherit',
            });
            child.once('error', reject);
            child.once('exit', (code) => resolve(code ?? 1));
          });
          if (status !== 0) {
            throw new Error(`Node testが失敗しました: ${status}`);
          }
          result.executed.push(test.id);
          result.durations[test.id] = performance.now() - started;
          result.timings.runMs += result.durations[test.id];
        }
        continue;
      }
      if (shard.runnerClass === 'e2e') {
        for (const test of group) {
          if (!isScenarioLocation(test.suite)) {
            throw new Error('E2Eシナリオの位置が不正です。');
          }
          const e2eStarted = performance.now();
          const status = await new Promise<number>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ['tools/e2e/run.mjs', 'pr', `--location=${test.suite}`],
              {
                cwd: root,
                stdio: 'inherit',
              },
            );
            child.once('error', reject);
            child.once('exit', (code) => resolve(code ?? 1));
          });
          if (status !== 0) {
            throw new Error(`E2Eが失敗しました: ${status}`);
          }
          result.executed.push(test.id);
          result.durations[test.id] = performance.now() - e2eStarted;
          result.timings.runMs += result.durations[test.id];
        }
        continue;
      }
      const prepareStarted = performance.now();
      const ctx = await createVitest({
        root: path.resolve(root, project),
        watch: false,
        maxWorkers: 2,
        allowOnly: false,
        reporters: [
          {
            onTestModuleEnd(module) {
              console.log(`${module.state()}: ${module.moduleId}`);
            },
          },
        ],
      });
      result.timings.prepareMs += performance.now() - prepareStarted;
      try {
        const collectStarted = performance.now();
        // 部分一致のCLI filterを使わず、全件検出した仕様を完全一致で渡す。
        const specifications = exactSpecifications(
          await ctx.globTestSpecifications(),
          group.map((test) => path.resolve(root, test.file)),
        );
        result.timings.collectMs += performance.now() - collectStarted;
        const runStarted = performance.now();
        const run = await ctx.runTestSpecifications(specifications);
        result.timings.runMs += performance.now() - runStarted;
        const completed = exactSpecifications(
          run.testModules,
          group.map((test) => path.resolve(root, test.file)),
        );
        for (const module of completed) {
          const test = group.find((test) => path.resolve(root, test.file) === module.moduleId);
          if (!test) {
            throw new Error('実行対象にないテストです。');
          }
          if (module.state() !== 'passed') {
            throw new Error(`テストが完了していません: ${test.id} (${module.state()})`);
          }
          result.executed.push(test.id);
          const d = module.diagnostic();
          result.fileTimings[test.id] = {
            prepareMs: d.prepareDuration + d.environmentSetupDuration,
            collectMs: d.collectDuration,
            runMs: d.duration,
            setupMs: d.setupDuration,
          };
          result.durations[test.id] = Math.max(
            0.001,
            d.duration +
              d.collectDuration +
              d.setupDuration +
              d.prepareDuration +
              d.environmentSetupDuration,
          );
        }
        if (
          run.unhandledErrors.length > 0 ||
          (process.exitCode !== undefined && process.exitCode !== 0)
        ) {
          throw new Error('Vitestが失敗しました。');
        }
      } finally {
        const teardownStarted = performance.now();
        await ctx.close();
        result.timings.teardownMs += performance.now() - teardownStarted;
      }
    }
    result.status = 'passed';
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
  }
  result.elapsedMs = performance.now() - started;
  return result;
}
