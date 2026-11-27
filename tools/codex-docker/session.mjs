import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const contextFile = join(homedir(), '.config', 'korekaite-shine', 'docker-context');
const labelKey = 'io.github.teitei-tk.korekaite-shine.codex-session';
const sessionIdPattern =
  /^(?:[\da-fA-F]{8}(?:-[\da-fA-F]{4}){3}-[\da-fA-F]{12}|thr_[\da-zA-Z]{1,128})$/u;
const dockerEndpointVariables = new Set([
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
]);

function executeDocker(args, timeout) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !dockerEndpointVariables.has(key)),
  );
  return execFileSync('docker', args, {
    encoding: 'utf8',
    env,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}

function readDockerContext() {
  try {
    return readFileSync(contextFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    throw new Error(`Docker コンテキストを ${contextFile} に設定してください`, { cause: error });
  }
}

function requireSessionId(value) {
  if (typeof value !== 'string' || !sessionIdPattern.test(value)) {
    throw new Error('有効な Codex セッション ID が必要です');
  }
  return value;
}

function localSocket(readContext, docker) {
  const context = readContext().trim();
  if (!/^[a-zA-Z\d][a-zA-Z\d_.-]*$/u.test(context)) {
    throw new Error('Docker コンテキスト名を1行で指定してください');
  }
  const socket = docker([
    'context',
    'inspect',
    '--format',
    '{{.Endpoints.docker.Host}}',
    '--',
    context,
  ]).trim();
  if (!/^unix:\/\/\/[^\r\n]+$/u.test(socket)) {
    throw new Error('Docker コンテキストにローカルの Unix ソケットを指定してください');
  }
  return socket;
}

function readSessionEnd(readInput) {
  const input = JSON.parse(readInput());
  if (input?.hook_event_name !== 'SessionEnd') {
    throw new Error('SessionEnd フックの入力が必要です');
  }
  return requireSessionId(input.session_id);
}

function cleanup(sessionId, readContext, docker) {
  const socket = localSocket(readContext, docker);
  const output = docker([
    '--host',
    socket,
    'ps',
    '--all',
    '--quiet',
    '--no-trunc',
    '--filter',
    `label=${labelKey}=${sessionId}`,
  ]).trim();
  if (output === '') {
    return '';
  }

  const ids = output.split(/\r?\n/u);
  if (!ids.every((id) => /^[\da-f]{64}$/u.test(id))) {
    throw new Error('Docker が完全なコンテナ ID を返しませんでした');
  }
  return docker(['--host', socket, 'rm', '--force', '--', ...ids]);
}

export function runSessionCommand(
  [command, ...args],
  {
    threadId = process.env.CODEX_THREAD_ID,
    readContext = readDockerContext,
    readInput = () => readFileSync(0, 'utf8'),
    docker = executeDocker,
  } = {},
) {
  if (command === 'run' && args[0]) {
    const sessionId = requireSessionId(threadId);
    const socket = localSocket(readContext, docker);
    return docker([
      '--host',
      socket,
      'run',
      '--detach',
      '--label',
      `${labelKey}=${sessionId}`,
      '--',
      ...args,
    ]);
  }

  if (command === 'cleanup' && args.length === 0) {
    const deadline = performance.now() + 2500;
    const sessionId = readSessionEnd(readInput);
    return cleanup(sessionId, readContext, (dockerArgs) => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) {
        throw new Error('Docker の削除処理が制限時間を超えました');
      }
      return docker(dockerArgs, remaining);
    });
  }

  if (command === 'cleanup' && args.length === 2 && args[0] === '--session') {
    return cleanup(requireSessionId(args[1]), readContext, docker);
  }

  throw new Error('使い方: session.mjs run IMAGE [COMMAND ...] または cleanup [--session ID]');
}

if (import.meta.main) {
  try {
    process.stdout.write(runSessionCommand(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`codex-docker: ${error.message}\n`);
    process.exitCode = 1;
  }
}
