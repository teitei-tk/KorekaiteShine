import { parseJson } from '@korekaite/api-contracts/json';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeEnvironment } from './environment.ts';
import { createFixtures, parseFixtures } from './fixtures.ts';
import { summarizeRecording } from './recording.ts';
import { parseExplorationOptions } from './options.ts';
import { launchRuntime, launchBrowser, launchBombadil } from './processes.ts';
import type { EngineOutcome } from './processes.ts';
import type { ExplorationOptions, ExplorationResult } from './types.ts';

function interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('探索を中断しました。'));
    signal.addEventListener('abort', abort, { once: true });
    void operation
      .then(resolve)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(reject);
    if (signal.aborted) {
      abort();
    }
  });
}

export async function runExploration(
  options: ExplorationOptions,
  signal?: AbortSignal,
): Promise<ExplorationResult> {
  // API経由でもCLIと同じ制約を適用する。
  parseExplorationOptions([
    '--target',
    options.target,
    '--seconds',
    String(options.seconds),
    ...(options.outputDirectory === undefined ? [] : ['--output', options.outputDirectory]),
    ...(options.reproduce === undefined ? [] : ['--reproduce', options.reproduce]),
  ]);
  const runId = randomUUID();
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const artifactDirectory = resolve(
    options.outputDirectory ?? join(root, '.local/bombadil', runId),
  );
  await mkdir(dirname(artifactDirectory), { recursive: true });
  await mkdir(artifactDirectory); // 既存の証拠を上書きしない。
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), (options.seconds + 150) * 1000);
  const interrupted = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const stop: (() => Promise<void>)[] = [];
  const state = {
    temporaryDirectory: '',
    engineStarted: false,
    collectPartial: false,
    reason: 'setup_failed',
    result: {
      status: 'infrastructure_error',
      actions: 0,
      reached: [],
      artifactDirectory,
    } as ExplorationResult,
  };
  const metadata: Record<string, string | number | object | null> = {
    version: 1,
    runId,
    target: options.target,
    seconds: options.seconds,
    startedAt: Math.floor(performance.timeOrigin + performance.now()),
    identity: null,
  };
  const saveMetadata = () =>
    writeFile(join(artifactDirectory, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  try {
    await saveMetadata();
    const environment = await interruptible(
      describeEnvironment(options.target, interrupted, [
        artifactDirectory,
        ...(options.reproduce ? [resolve(options.reproduce)] : []),
      ]),
      interrupted,
    );
    metadata.identity = environment.identity;
    if (options.reproduce) {
      state.reason = 'reproduction_mismatch';
    }
    const fixtures = options.reproduce
      ? parseFixtures(await readFile(join(resolve(options.reproduce), 'fixtures.json'), 'utf8'))
      : createFixtures(randomUUID());
    const fixtureText = JSON.stringify(fixtures);
    const fixtureHash = createHash('sha256').update(fixtureText).digest('hex');
    metadata.fixtureHash = fixtureHash;
    if (options.reproduce) {
      const previous = parseJson(
        await readFile(join(resolve(options.reproduce), 'metadata.json'), 'utf8'),
      );
      if (
        previous === null ||
        typeof previous !== 'object' ||
        Array.isArray(previous) ||
        previous.version !== 1 ||
        previous.target !== options.target ||
        JSON.stringify(previous.identity) !== JSON.stringify(environment.identity) ||
        previous.fixtureHash !== fixtureHash
      ) {
        throw new Error('再現条件が一致しません。');
      }
    }
    const fixturePath = join(artifactDirectory, 'fixtures.json');
    await writeFile(fixturePath, `${fixtureText}\n`);
    const specPath = join(artifactDirectory, 'entry.spec.ts');
    await writeFile(
      specPath,
      [
        `import { createSpecification } from ${JSON.stringify(environment.specPath)};`,
        `const specification = createSpecification(${fixtureText});`,
        'export const explore = specification.explore;',
        'export const invariant = specification.invariant;',
        '',
      ].join('\n'),
    );
    await saveMetadata();
    state.temporaryDirectory = await mkdtemp(join(tmpdir(), 'bombadil-runtime-'));
    interrupted.throwIfAborted();
    state.reason = 'runtime_start_failed';
    const runtime = launchRuntime({ fixturePath, temporaryDirectory: state.temporaryDirectory });
    stop.push(runtime.stop);
    const url = await interruptible(runtime.result, interrupted);
    state.reason = 'browser_start_failed';
    interrupted.throwIfAborted();
    const browser = launchBrowser({
      chrome: environment.chrome,
      temporaryDirectory: state.temporaryDirectory,
    });
    stop.push(browser.stop);
    const remoteDebugger = await interruptible(browser.result, interrupted);
    state.reason = 'engine_failed';
    interrupted.throwIfAborted();
    const engine = launchBombadil({
      ...environment,
      specPath,
      remoteDebugger,
      url,
      seconds: options.seconds,
      outputDirectory: join(artifactDirectory, 'bombadil'),
      ...(options.reproduce ? { reproduce: join(resolve(options.reproduce), 'bombadil') } : {}),
    });
    stop.push(engine.stop);
    state.engineStarted = true;
    const outcome: EngineOutcome = await interruptible(engine.result, interrupted);
    metadata.engine = { exitCode: outcome.exitCode, signal: outcome.signal };
    const wasInterrupted =
      outcome.signal === 'SIGINT' ||
      outcome.signal === 'SIGTERM' ||
      outcome.stdout.includes('interrupted by SIGINT');
    const summary = await summarizeRecording({
      target: options.target,
      exitCode: outcome.exitCode,
      path: join(artifactDirectory, 'bombadil/trace.jsonl'),
      interrupted: wasInterrupted,
    });
    const terminal =
      /Test finished after time limit|Test finished with all properties definite|Reproduction finished/u.test(
        outcome.stdout,
      );
    state.result = { ...summary, artifactDirectory };
    if (summary.status === 'passed' && !terminal) {
      state.result.status = 'infrastructure_error';
    }
    state.reason = wasInterrupted ? 'interrupted' : state.result.status;
  } catch {
    if (interrupted.aborted) {
      state.result.status = 'incomplete';
      state.reason = deadline.signal.aborted ? 'deadline' : 'interrupted';
      state.collectPartial = state.engineStarted;
    }
  } finally {
    // 操作に探索時間+150秒、並列の停止に最大30秒を割り当てる。
    const cleanup = await Promise.allSettled(stop.map((operation) => operation()));
    clearTimeout(timer);
    if (cleanup.some((result) => result.status === 'rejected')) {
      state.result.status = 'infrastructure_error';
      state.reason = 'cleanup_failed';
    } else if (state.temporaryDirectory) {
      await rm(state.temporaryDirectory, { recursive: true, force: true });
    }
    if (state.collectPartial) {
      try {
        const partial = await summarizeRecording({
          target: options.target,
          exitCode: null,
          interrupted: true,
          path: join(artifactDirectory, 'bombadil/trace.jsonl'),
        });
        state.result.actions = partial.actions;
        state.result.reached = partial.reached;
        if (partial.status === 'infrastructure_error' && state.result.status === 'incomplete') {
          state.result.status = 'infrastructure_error';
          state.reason = 'recording_invalid';
        }
      } catch (error) {
        // 最初の記録を出す前に中断した場合は操作ゼロの未完了として残す。
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          state.result.status = 'infrastructure_error';
          state.reason = 'recording_invalid';
        }
      }
    }
    metadata.reason = state.reason;
    metadata.finishedAt = Math.floor(performance.timeOrigin + performance.now());
    await saveMetadata();
    await writeFile(
      join(artifactDirectory, 'result.json'),
      `${JSON.stringify(state.result, null, 2)}\n`,
    );
  }
  return state.result;
}
