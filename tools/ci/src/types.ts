export type RunnerClass = 'node' | 'worker' | 'boundary' | 'integration' | 'e2e';
export type Test = {
  id: string;
  file: string;
  project: string;
  suite: string;
  runnerClass: RunnerClass;
};
export type Shard = {
  id: string;
  runner: string;
  runnerClass: RunnerClass;
  tests: string[];
  predictedMs: number;
};
export type Plan = {
  schema: 1;
  sha: string;
  baseSha: string | null;
  headSha: string | null;
  mode: 'all' | 'affected';
  graphVersion: 1;
  historyId: string | null;
  inventoryHash: string;
  reasons: string[];
  tests: Test[];
  selected: string[];
  shards: Shard[];
  repository: string;
  workflow: string;
};
export type Result = {
  schema: 1;
  sha: string;
  inventoryHash: string;
  shardId: string;
  status: 'passed' | 'failed';
  executed: string[];
  durations: Record<string, number>;
  elapsedMs: number;
  timings: { prepareMs: number; collectMs: number; runMs: number; teardownMs: number };
  fileTimings: Record<
    string,
    { prepareMs: number; collectMs: number; runMs: number; setupMs: number }
  >;
  identity: string;
  error?: string;
};
export const identity = (runnerClass: RunnerClass) =>
  `${runnerClass}:${process.platform}:node${process.versions.node.split('.')[0]}:workers2`;
