import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseEnvironment, type AppEnvironment } from './environment.ts';

export interface RuntimeInput {
  repositoryRoot: string;
  appEnv: string | undefined;
  runId?: string;
  parallelIndex?: number;
}

export interface QueuePair {
  queue: string;
  dlq: string;
}

export interface RuntimeConfig {
  environment: AppEnvironment;
  workers: { web: string; interview: string; evaluation: string };
  d1: { name: string; id: string };
  doOwner: string;
  queues: { evaluation: QueuePair; diagnostics?: QueuePair };
  stateDirectory: string | null;
  artifactDirectory: string;
}

function queuePair(name: string): QueuePair {
  return { queue: name, dlq: `${name}-dlq` };
}

export function resolveRuntime(input: RuntimeInput): RuntimeConfig {
  const environment = parseEnvironment(input.appEnv);
  if (
    environment === 'test' &&
    (!input.runId ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.runId) ||
      input.parallelIndex === undefined ||
      !Number.isSafeInteger(input.parallelIndex) ||
      input.parallelIndex < 0)
  ) {
    throw new Error('テスト実行IDと0以上の整数の並列番号を指定してください。');
  }
  const testId = createHash('sha256')
    .update(`${input.runId}\0${input.parallelIndex}`)
    .digest('hex')
    .slice(0, 16);
  const suffix =
    environment === 'test' ? `test-${testId}` : environment === 'production' ? 'prod' : 'dev';
  const databaseName =
    environment === 'test'
      ? `korekaite_test_${testId}`
      : environment === 'production'
        ? 'korekaite_prod'
        : 'korekaite_development';
  const localRoot =
    environment === 'test'
      ? join(input.repositoryRoot, '.local/tests', String(input.runId), String(input.parallelIndex))
      : join(input.repositoryRoot, '.local/development');
  const workers = {
    web: `korekaite-web-${suffix}`,
    interview: `korekaite-interview-${suffix}`,
    evaluation: `korekaite-evaluation-${suffix}`,
  };
  return {
    environment,
    workers,
    d1: { name: databaseName, id: databaseName },
    doOwner: workers.interview,
    queues: {
      evaluation: queuePair(`korekaite-evaluation-${suffix}`),
      ...(environment === 'production'
        ? {}
        : { diagnostics: queuePair(`korekaite-diagnostics-${suffix}`) }),
    },
    stateDirectory: environment === 'production' ? null : join(localRoot, 'state'),
    artifactDirectory:
      environment === 'production'
        ? join(input.repositoryRoot, '.local/artifacts/production')
        : join(localRoot, 'artifacts'),
  };
}
