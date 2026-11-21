import { fork, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localProcessEnvironment } from '../../local-integration/src/local-environment.ts';
import { stopProcessGroup } from '../../local-integration/src/process.ts';
import { repositoryRoot } from './environment.ts';

export type OwnedProcess<T> = {
  result: Promise<T>;
  stop: () => Promise<void>;
};

function stopOnce(child: ChildProcess, graceMs = 5000) {
  const state = { stopping: undefined as Promise<void> | undefined };
  return () => (state.stopping ??= stopProcessGroup(child, { graceMs, killMs: 5000 }));
}

export function launchRuntime(input: {
  fixturePath: string;
  temporaryDirectory: string;
}): OwnedProcess<string> {
  const child = fork(new URL('runtime-host.ts', import.meta.url), [input.fixturePath], {
    execArgv: [],
    detached: true,
    env: {
      ...localProcessEnvironment(),
      E2E_APP_ROOT: repositoryRoot,
      TMPDIR: input.temporaryDirectory,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const result = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => reject(new Error('探索用ランタイムが終了しました。')));
    child.on('message', (message: { type?: string; url?: string } | null) => {
      if (
        message?.type === 'ready' &&
        typeof message.url === 'string' &&
        URL.canParse(message.url)
      ) {
        const url = new URL(message.url);
        if (
          url.protocol === 'http:' &&
          url.hostname === '127.0.0.1' &&
          url.pathname === '/' &&
          !url.username &&
          !url.password
        ) {
          resolve(url.origin);
          return;
        }
      }
      reject(new Error('探索用ランタイムの起動通知が不正です。'));
    });
  });
  return { result, stop: stopOnce(child, 25_000) };
}

export function launchBrowser(input: {
  chrome: string;
  temporaryDirectory: string;
}): OwnedProcess<string> {
  const profile = join(input.temporaryDirectory, 'chrome');
  const child = spawn(
    input.chrome,
    [
      '--headless',
      // CIのrootコンテナではChromeのsandboxを起動できない。
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--no-pings',
      '--disable-crash-reporter',
      '--use-mock-keychain',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      'about:blank',
    ],
    { cwd: repositoryRoot, detached: true, stdio: 'ignore', env: localProcessEnvironment() },
  );
  const state = { stopped: false, failed: false };
  child.once('error', () => {
    state.failed = true;
  });
  child.once('exit', () => {
    state.failed = true;
  });
  const result = (async () => {
    const deadline = performance.now() + 30_000;
    while (!state.stopped && !state.failed && performance.now() < deadline) {
      try {
        const port = Number(
          (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
        );
        if (Number.isInteger(port) && port > 0 && port <= 65_535) {
          return `http://127.0.0.1:${port}`;
        }
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
      await delay(25);
    }
    throw new Error('探索用ブラウザを起動できませんでした。');
  })();
  const stop = stopOnce(child);
  return {
    result,
    async stop() {
      state.stopped = true;
      await stop();
      await result.catch(() => {
        /* この経路では追加の処理を行わない。 */
      });
    },
  };
}

export type EngineOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
};

export function launchBombadil(input: {
  binary: string;
  remoteDebugger: string;
  specPath: string;
  url: string;
  seconds: number;
  outputDirectory: string;
  reproduce?: string;
}): OwnedProcess<EngineOutcome> {
  const args = [
    'browser',
    'test-external',
    '--remote-debugger',
    input.remoteDebugger,
    '--create-target',
    '--output-path',
    input.outputDirectory,
    '--allow-url',
    `${input.url}/practice`,
  ];
  if (input.reproduce) {
    args.push('--reproduce', input.reproduce);
  } else {
    args.push('--time-limit', `${input.seconds}s`, '--exit-on-violation');
  }
  args.push(`${input.url}/practice`, input.specPath);
  const child = spawn(input.binary, args, {
    cwd: repositoryRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: localProcessEnvironment(),
  });
  const output = { text: '' };
  const collect = (chunk: Buffer) => {
    output.text = (output.text + chunk.toString()).slice(-1_048_576);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const result = new Promise<EngineOutcome>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stdout: output.text }));
  }).then(async (outcome) => {
    await mkdir(input.outputDirectory, { recursive: true });
    await writeFile(join(input.outputDirectory, 'engine.log'), outcome.stdout);
    return outcome;
  });
  const stop = stopOnce(child);
  return {
    result,
    async stop() {
      await stop();
      await result.catch(() => {
        /* この経路では追加の処理を行わない。 */
      });
    },
  };
}
