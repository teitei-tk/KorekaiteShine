import { parseJson } from './json.ts';
import type { JsonValue } from './json.ts';
import { parsePlan, parseResult, runnerClasses } from './schema.ts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { assignTests } from './plan.ts';
import { readWeights, mergeHistory } from './history.ts';
import type { History } from './history.ts';
import { validateResults } from './results.ts';
import { identity } from './types.ts';
import type { Plan, Result, RunnerClass } from './types.ts';
const { resolve } = path;
const root = process.cwd();
const git = (args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const json = async (path: string) => parseJson(await readFile(resolve(root, path), 'utf8'));
const save = async (path: string, value: Plan | Result | History) =>
  writeFile(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
async function graphAt(sha: string) {
  const { buildGraph } = await import('./graph.ts');
  const paths = git(['ls-tree', '-r', '--name-only', '-z', sha]).split('\0').filter(Boolean);
  const files = new Map<string, string>();
  // blobだけを読み、比較元の設定・コードは実行しない。
  for (const path of paths) {
    if (/\.(?:[cm]?[jt]sx?|json|sql|tsp|ya?ml|md|feature|toml)$/u.test(path)) {
      files.set(path, git(['show', `${sha}:${path}`]));
    }
  }
  return buildGraph(files);
}
async function makePlan(): Promise<Plan> {
  const { inventory } = await import('./inventory.ts');
  const { mergeGraphs, affectedTests } = await import('./graph.ts');
  const tests = await inventory(root);
  const sha = process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']).trim();
  const headSha = process.env.HEAD_SHA ?? null;
  const baseSha = process.env.BASE_SHA ?? null;
  const repository =
    process.env.GITHUB_REPOSITORY ?? git(['config', '--get', 'remote.origin.url']).trim();
  const workflow = process.env.GITHUB_WORKFLOW ?? 'CI';
  const selection: { selected: string[]; mode: Plan['mode'] } = {
    selected: tests.map((test) => test.id),
    mode: 'all',
  };
  const reasons = ['main・手動実行は全件'];
  if (process.env.EVENT_NAME === 'pull_request' && process.env.CI_TEST_SELECTION !== 'all') {
    try {
      if (!baseSha || !headSha) {
        throw new Error('比較SHAがありません。');
      }
      if (![baseSha, headSha, sha].every((value) => /^[a-f0-9]{40,64}$/u.test(value))) {
        throw new Error('SHA形式が不正です。');
      }
      const mergeBase = git(['merge-base', baseSha, headSha]).trim();
      const changed = [
        ...new Set(
          [
            ...git(['diff', '--name-only', '--no-renames', '-z', mergeBase, headSha]).split('\0'),
            ...git(['diff', '--name-only', '--no-renames', '-z', headSha, sha]).split('\0'),
          ].filter(Boolean),
        ),
      ];
      const graph = mergeGraphs(await graphAt(mergeBase), await graphAt(sha));
      const files = new Set(
        affectedTests(
          graph,
          changed,
          tests.map((test) => test.file),
        ),
      );
      selection.selected = tests.filter((test) => files.has(test.file)).map((test) => test.id);
      selection.mode = 'affected';
      reasons.splice(
        0,
        reasons.length,
        ...(changed.length > 0
          ? changed.map((path) => `変更起点: ${path}`)
          : ['比較差分は空です。']),
      );
      if (graph.unsafe) {
        reasons.push('未解決または解析不能の依存があるため全件へ拡大');
      }
    } catch (error) {
      reasons.splice(0, reasons.length, `比較不能のため全件: ${String(error)}`);
    }
  }
  const historyInput: JsonValue = await json(
    process.env.CI_HISTORY_PATH ?? '.ci/history-input.json',
  ).catch(() => null);
  const seedInput = await json('tools/ci/timing-seed.json').catch(() => null);
  const plan: Plan = {
    schema: 1,
    sha,
    baseSha,
    headSha,
    mode: selection.mode,
    graphVersion: 1,
    historyId: null,
    inventoryHash: createHash('sha256').update(JSON.stringify(tests)).digest('hex'),
    reasons,
    tests,
    selected: selection.selected,
    shards: [],
    repository,
    workflow,
  };
  const counts: Record<RunnerClass, number> = {
    node: 3,
    worker: 3,
    boundary: 4,
    integration: 3,
    e2e: 4,
  };
  for (const kind of runnerClasses) {
    const group = tests.filter(
      (test) => test.runnerClass === kind && selection.selected.includes(test.id),
    );
    const history = readWeights(
      historyInput,
      seedInput,
      { repository, workflow, now: Temporal.Now.instant().epochMilliseconds },
      identity(kind),
    );
    if (history.id && group.length > 0 && process.env.CI_TEST_WEIGHTS !== 'equal') {
      plan.historyId = history.id;
      reasons.push(`${kind}の配分時間: ${history.sources.join(', ')}`);
    }
    const durations = process.env.CI_TEST_WEIGHTS === 'equal' ? {} : history.durations;
    for (const [index, ids] of assignTests(
      group.map((test) => test.id),
      durations,
      counts[kind],
    ).entries()) {
      const values = Object.values(durations).toSorted((a, b) => a - b);
      const fallback = values[Math.max(0, Math.ceil(values.length * 0.75) - 1)] ?? 1;
      plan.shards.push({
        id: `${kind}-${index + 1}`,
        runner: 'ubuntu-latest',
        runnerClass: kind,
        tests: ids,
        predictedMs: ids.reduce((total, id) => total + (durations[id] ?? fallback), 0),
      });
    }
  }
  return plan;
}
export async function main() {
  await mkdir(resolve(root, '.ci/results'), { recursive: true });
  const [command, id] = process.argv.slice(2);
  if (command === 'plan') {
    const plan = await makePlan();
    await save('.ci/plan.json', plan);
    const matrix = {
      include: plan.shards.map(({ id, runner, runnerClass }) => ({ id, runner, runnerClass })),
    };
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `matrix=${JSON.stringify(matrix)}\nhas_tests=${plan.selected.length > 0}\n`,
      );
    }
    console.log(
      JSON.stringify({ tests: plan.tests.length, selected: plan.selected.length, matrix }),
    );
    return;
  }
  const plan = parsePlan(await readFile(resolve(root, '.ci/plan.json'), 'utf8'));
  if (process.env.GITHUB_SHA && plan.sha !== process.env.GITHUB_SHA) {
    throw new Error('実行SHAが計画と一致しません。');
  }
  if (command === 'run') {
    const shard = plan.shards.find((shard) => shard.id === id);
    if (!shard || !/^(?:node|worker|boundary|integration|e2e)-[1-9]\d*$/u.test(shard.id)) {
      throw new Error('シャードIDが不正です。');
    }
    const { runShard } = await import('./run.ts');
    const result = await runShard(root, plan, shard);
    await save(`.ci/results/${shard.id}.json`, result);
    if (result.status !== 'passed') {
      console.error(result.error);
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'result') {
    const files = (await readdir(resolve(root, '.ci/results'))).filter((file) =>
      file.endsWith('.json'),
    );
    const results = await Promise.all(
      files.map(async (file) =>
        parseResult(await readFile(resolve(root, `.ci/results/${file}`), 'utf8')),
      ),
    );
    validateResults(plan, results);
    if (
      plan.mode === 'all' &&
      process.env.GITHUB_EVENT_NAME === 'push' &&
      process.env.GITHUB_REF === 'refs/heads/main'
    ) {
      const samples = results.flatMap((result) =>
        Object.entries(result.durations).map(([id, durationMs]) => ({
          id,
          identity: result.identity,
          durationMs,
        })),
      );
      const history: History = {
        schema: 1,
        id: process.env.GITHUB_RUN_ID ?? plan.sha,
        repository: plan.repository,
        workflow: plan.workflow,
        event: 'push',
        branch: 'main',
        conclusion: 'success',
        createdAt: Temporal.Now.instant().toString(),
        samples,
      };
      const previous = await json(process.env.CI_HISTORY_PATH ?? '.ci/history-input.json').catch(
        () => null,
      );
      await save('.ci/history.json', mergeHistory(previous, history));
    }
    console.log(`計画の${plan.selected.length}件・${plan.shards.length}シャードが完了しました。`);
    return;
  }
  throw new Error('plan、run <shard-id>、resultを指定してください。');
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
