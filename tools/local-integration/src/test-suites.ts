const integrationGroups = [
  ['restart'],
  ['cli-recovery', 'isolation'],
  ['end-to-end', 'formal-routing', 'dlq-restart', 'queue-retry'],
];
const paths = (names: readonly string[]) => names.map((name) => `tests/${name}.test.ts`);
const boundaryGroups = [
  [
    'check-object',
    'recovery',
    'check-object-guards',
    'migrations',
    'ci-selection',
    'test-suites',
    'run-test-suite',
  ],
  [
    'topology',
    'execution',
    'dispatch-notifications',
    'runtime-owner',
    'evaluation-exception',
    'lock',
    'evidence',
  ],
  [
    'delivery-anomalies',
    'lease',
    'http-contract',
    'schema',
    'notification-runtime',
    'readiness',
    'integration-run',
  ],
  [
    'dlq',
    'diagnostics',
    'production-artifacts',
    'source-sync',
    'process',
    'notification-runtime-lifecycle',
    'commands',
  ],
];
export function selectTestFiles(suite: string, shard?: number): readonly string[] {
  const groups =
    suite === 'boundary'
      ? boundaryGroups
      : suite === 'integration-pr'
        ? integrationGroups
        : undefined;
  if (groups) {
    if (shard === undefined) {
      return paths(groups.flat());
    }
    if (!Number.isInteger(shard) || shard < 1 || shard > groups.length) {
      throw new Error('分割番号が範囲外です。');
    }
    return paths(groups[shard - 1]!);
  }
  if (shard !== undefined) {
    throw new Error('この検査には分割番号を指定できません。');
  }
  if (suite === 'realtime') {
    return paths(['realtime-retries']);
  }
  if (suite === 'integration-all') {
    return [...paths(integrationGroups.flat()), ...paths(['realtime-retries'])];
  }
  throw new Error('検査の種類が不明です。');
}

export function validateTestFiles(discovered: readonly string[]): void {
  const registered = [...selectTestFiles('boundary'), ...selectTestFiles('integration-all')];
  const expected = new Set(registered);
  const actual = new Set(discovered);
  if (
    expected.size !== registered.length ||
    actual.size !== discovered.length ||
    actual.size === 0 ||
    expected.size !== actual.size ||
    discovered.some((file) => !expected.has(file))
  ) {
    throw new Error('テストファイルの登録に重複・欠落・未登録があります。');
  }
}
