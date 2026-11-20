import { isPlan, isResult } from './schema.ts';
export function validateResults(plan: unknown, results: unknown): void {
  if (!isPlan(plan) || !Array.isArray(results) || !results.every((value) => isResult(value))) {
    throw new Error('計画・結果が不正です。');
  }
  const assigned = plan.shards.flatMap((shard) => shard.tests);
  const equal = (a: string[], b: string[]) =>
    a.length === b.length &&
    [...a].toSorted().every((id, index) => id === [...b].toSorted()[index]);
  if (
    new Set(assigned).size !== assigned.length ||
    !equal(assigned, plan.selected) ||
    results.length !== plan.shards.length ||
    new Set(results.map((result) => result.shardId)).size !== results.length
  ) {
    throw new Error('実行結果が不足・重複しています。');
  }
  for (const shard of plan.shards) {
    const result = results.find((value) => value.shardId === shard.id);
    if (
      result?.sha !== plan.sha ||
      result.inventoryHash !== plan.inventoryHash ||
      result.status !== 'passed' ||
      !equal(result.executed, shard.tests)
    ) {
      throw new Error(`シャードの実行が完了していません: ${shard.id}`);
    }
  }
}
