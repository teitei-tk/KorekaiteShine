import { expect, test } from 'vitest';
import { resolveRuntime } from '../src/resources.ts';

test('APP_ENVが未指定なら接続設定を生成しない', () => {
  expect(() => resolveRuntime({ repositoryRoot: '/repo', appEnv: undefined })).toThrow('APP_ENV');
});

test('APP_ENVの誤記を既定環境へ読み替えない', () => {
  expect(() => resolveRuntime({ repositoryRoot: '/repo', appEnv: 'developmnt' })).toThrow(
    'APP_ENV',
  );
});

test('開発の3 Workersと共有D1・用途別Queueを同じ環境へ対応させる', () => {
  const runtime = resolveRuntime({ repositoryRoot: '/repo', appEnv: 'development' });
  expect(runtime.workers).toEqual({
    web: 'korekaite-web-dev',
    interview: 'korekaite-interview-dev',
    evaluation: 'korekaite-evaluation-dev',
  });
  expect(runtime.d1.name).toBe('korekaite_development');
  expect(runtime.doOwner).toBe('korekaite-interview-dev');
  expect(runtime.queues).toEqual({
    evaluation: { queue: 'korekaite-evaluation-dev', dlq: 'korekaite-evaluation-dev-dlq' },
    diagnostics: { queue: 'korekaite-diagnostics-dev', dlq: 'korekaite-diagnostics-dev-dlq' },
  });
  expect(runtime.stateDirectory).toBe('/repo/.local/development/state');
  expect(runtime.artifactDirectory).toBe('/repo/.local/development/artifacts');
});

test('テストの実行と並列番号ごとに接続先・保存先・生成先を分離する', () => {
  const first = resolveRuntime({
    repositoryRoot: '/repo',
    appEnv: 'test',
    runId: 'run-a',
    parallelIndex: 0,
  });
  const sibling = resolveRuntime({
    repositoryRoot: '/repo',
    appEnv: 'test',
    runId: 'run-a',
    parallelIndex: 1,
  });
  const another = resolveRuntime({
    repositoryRoot: '/repo',
    appEnv: 'test',
    runId: 'run-b',
    parallelIndex: 0,
  });
  const dev = resolveRuntime({ repositoryRoot: '/repo', appEnv: 'development' });
  for (const other of [sibling, another, dev]) {
    expect(first.workers.web).not.toBe(other.workers.web);
    expect(first.doOwner).not.toBe(other.doOwner);
    expect(first.d1.id).not.toBe(other.d1.id);
    expect(first.queues.diagnostics?.queue).not.toBe(other.queues.diagnostics?.queue);
    expect(first.queues.evaluation.dlq).not.toBe(other.queues.evaluation.dlq);
    expect(first.stateDirectory).not.toBe(other.stateDirectory);
    expect(first.artifactDirectory).not.toBe(other.artifactDirectory);
  }
  expect(first.workers.web).toMatch(/^korekaite-web-test-[a-f0-9]{16}$/u);
  expect(first.stateDirectory).toBe('/repo/.local/tests/run-a/0/state');
  expect(first.artifactDirectory).toBe('/repo/.local/tests/run-a/0/artifacts');
  expect(
    resolveRuntime({ repositoryRoot: '/repo', appEnv: 'test', runId: 'run-a', parallelIndex: 0 }),
  ).toEqual(first);
});

test('テスト識別子の不足やパスを抜ける値は起動前に拒否する', () => {
  for (const fields of [
    {},
    { runId: 'run-a' },
    { parallelIndex: 0 },
    { runId: '../development', parallelIndex: 0 },
    { runId: 'run-a', parallelIndex: -1 },
    { runId: 'run-a', parallelIndex: 1.5 },
  ]) {
    expect(() => resolveRuntime({ repositoryRoot: '/repo', appEnv: 'test', ...fields })).toThrow(
      'テスト',
    );
  }
});

test('本番設定は診断配送先とローカル永続化先を持たない', () => {
  const runtime = resolveRuntime({ repositoryRoot: '/repo', appEnv: 'production' });
  expect(runtime.workers.web).toBe('korekaite-web-prod');
  expect(runtime.d1.name).toBe('korekaite_prod');
  expect(runtime.queues.evaluation.queue).toBe('korekaite-evaluation-prod');
  expect(runtime.queues.diagnostics).toBeUndefined();
  expect(runtime.stateDirectory).toBeNull();
  expect(runtime.artifactDirectory).toBe('/repo/.local/artifacts/production');
});
