// 廃棄可能な検証環境専用。公式プロキシの代替実装でも、本番の起動ラッパーでもない。
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  requireIsolationReport,
  type IsolationInput,
  type IsolationReport,
} from '../isolation-probe.js';

const home = '/home/ai-review/.codex';
const privateDir = '/opt/ai-review-probe/private';
const reportFile = `${privateDir}/upstream-report.json`;
type Report = { count: number; authOk: boolean };
type Info = { port: number; pid: number };
type Identity = { pid: number; start: string };
type State = {
  proxy: Identity;
  backend: Identity;
  infoPath: string;
  configHash: string;
  startedAt: string;
};

export function lifecyclePassed(
  mode: string,
  outcome: string,
  report: Report,
  output: string,
  elapsedMs: number,
): boolean {
  return (
    // Actionの3分timeoutより短い検証期限。時間切れを期待した拒否と取り違えない。
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0 &&
    elapsedMs < 150000 &&
    Number.isInteger(report.count) &&
    report.count > 0 &&
    report.authOk === true &&
    ((mode === 'complete' &&
      outcome === 'success' &&
      output.trim() === 'offline fixture complete') ||
      (mode === 'reject' && outcome === 'failure' && output === ''))
  );
}

export function identity(pid: number): Identity {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!/^\d+$/.test(start ?? '')) throw new Error('process identity unavailable');
  return { pid, start };
}
export function alive(process: Identity): boolean {
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    return (
      stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z' &&
      identity(process.pid).start === process.start
    );
  } catch {
    return false;
  }
}
export function configHash(): string {
  return createHash('sha256')
    .update(readFileSync(`${home}/config.toml`))
    .digest('hex');
}
export async function readInfo(path: string, timeoutMs = 5000): Promise<Info> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info: Partial<Info> = JSON.parse(readFileSync(path, 'utf8'));
      if (
        Number.isInteger(info.port) &&
        info.port! > 0 &&
        info.port! < 65536 &&
        Number.isInteger(info.pid) &&
        info.pid! > 0
      )
        return info as Info;
    } catch {
      /* 書込み途中だけ再試行。成功は有効なJSONを読めた場合のみ。 */
    }
    await delay(50);
  }
  throw new Error('official proxy or fixture did not become ready');
}
export function start(program: string, args: string[], input?: string): number {
  const child = spawn(program, args, {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' },
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.on('error', () => {
    process.exitCode = 1;
  });
  child.stdin.on('error', () => {
    process.exitCode = 1;
  });
  child.stdin.end(input);
  child.unref();
  if (!child.pid) throw new Error('failed to start fixture process');
  return child.pid;
}

async function serve(mode: string): Promise<void> {
  const report: Report = { count: 0, authOk: true };
  const server = createServer((req, res) => {
    // 模擬値との一致だけを保存し、Bearerや要求本文は記録しない。
    report.count++;
    report.authOk &&=
      req.url === '/responses' &&
      req.method === 'POST' &&
      req.headers.authorization === 'Bearer dummy-only';
    writeFileSync(reportFile, JSON.stringify(report), { mode: 0o600 });
    req.resume();
    if (mode === 'reject') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"offline fixture rejection","type":"invalid_request_error"}}');
      return;
    }
    // 固定の応答fixture。推論・ツール呼出し・外部転送は行わない。
    const events = [
      { type: 'response.created', response: { id: 'resp_fixture' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'msg_fixture',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'offline fixture complete', annotations: [] }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_fixture',
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture receiver unavailable');
  writeFileSync(
    `${privateDir}/backend.json`,
    JSON.stringify({ port: address.port, pid: process.pid }),
    { mode: 0o600 },
  );
}

export function configureProxy(port: number, model: 'isolation-fixture' | 'gpt-6-luna'): void {
  writeFileSync(
    `${home}/config.toml`,
    `model = "${model}"
model_provider = "official-proxy"
approval_policy = "never"
sandbox_mode = "read-only"
sqlite_home = "${home}/tmp"
log_dir = "${home}/tmp"
[model_providers.official-proxy]
name = "Official proxy isolation fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[projects."/opt/ai-review-probe/pr"]
trust_level = "untrusted"
`,
  );
}

export function verifyProxyIsolation(
  proxy: Info,
  infoPath: string,
  protectedProcesses: number[] = [],
  additionalReadOnlyFiles: string[] = [],
): void {
  const input: IsolationInput = {
    expectedUid: 2001,
    parentPid: proxy.pid,
    protectedProcesses,
    parentPidNamespace: readlinkSync('/proc/self/ns/pid'),
    protectedFiles: [`${privateDir}/dummy-token`],
    readOnlyDirectories: ['/opt/ai-review-probe/pr', home, '/tmp', `${home}/tmp`],
    readOnlyFiles: [
      `${home}/config.toml`,
      infoPath,
      `${home}/installation_id`,
      ...additionalReadOnlyFiles,
    ],
    port: proxy.port,
    env: {},
  };
  writeFileSync('/opt/ai-review-probe/input.json', JSON.stringify(input), { mode: 0o444 });
  const outside = spawnSync(
    '/usr/bin/sudo',
    ['-u', 'ai-review', '--', '/usr/local/bin/node', '/opt/ai-review-probe/pr/probe-child.js'],
    { encoding: 'utf8', timeout: 10000 },
  );
  if (outside.error || outside.status === null) throw new Error('proxy boundary probe failed');
  const report: IsolationReport = JSON.parse(outside.stdout);
  const required = [
    'uid',
    'groups',
    'credential-environment',
    'protected-file-0',
    'parent-environ',
    'parent-mem',
    'read-only-file-0',
    'read-only-file-1',
    'sudo',
    ...protectedProcesses.flatMap((_, index) => [
      `runner-process-${index}-environ`,
      `runner-process-${index}-mem`,
    ]),
  ];
  if (
    report.pidNamespace !== input.parentPidNamespace ||
    !required.every((name) => report.checks.some((check) => check.name === name && check.passed))
  )
    throw new Error('proxy credentials or configuration are accessible');
  const inside = spawnSync(
    '/usr/bin/sudo',
    [
      '-u',
      'ai-review',
      '--',
      '/usr/local/bin/codex',
      'sandbox',
      '--permission-profile',
      ':read-only',
      '--cd',
      '/opt/ai-review-probe/pr',
      '--',
      '/usr/local/bin/node',
      '/opt/ai-review-probe/pr/probe-child.js',
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  if (inside.error || inside.status !== 0) throw new Error('proxy sandbox probe failed');
  requireIsolationReport(
    inside.stdout,
    report.checks.map((check) => check.name),
  );
}

async function prepare(mode: string, runId: string): Promise<void> {
  const started: Identity[] = [];
  const infoPath = `${home}/${runId}.json`;
  try {
    const backendPid = start('/usr/local/bin/node', [
      fileURLToPath(import.meta.url),
      'serve',
      mode,
    ]);
    started.push(identity(backendPid));
    const backend = await readInfo(`${privateDir}/backend.json`);
    if (backend.pid !== backendPid) throw new Error('backend identity mismatch');
    const proxyPid = start(
      '/usr/local/bin/codex-responses-api-proxy',
      [
        '--http-shutdown',
        '--server-info',
        infoPath,
        '--upstream-url',
        `http://127.0.0.1:${backend.port}/responses`,
      ],
      'dummy-only\n',
    );
    started.push(identity(proxyPid));
    const proxy = await readInfo(infoPath);
    if (proxy.pid !== proxyPid) throw new Error('proxy identity mismatch');
    chmodSync(infoPath, 0o444);
    configureProxy(proxy.port, 'isolation-fixture');
    const state: State = {
      proxy: identity(proxyPid),
      backend: identity(backendPid),
      infoPath,
      configHash: configHash(),
      startedAt: process.hrtime.bigint().toString(),
    };
    writeFileSync(`${privateDir}/lifecycle.json`, JSON.stringify(state), { mode: 0o600 });
    verifyProxyIsolation(proxy, infoPath);
    if (!alive(state.proxy)) throw new Error('proxy exited during probe');
    console.log('official proxy memory, config and server-info isolation: passed');
  } catch (error) {
    for (const child of started) if (alive(child)) process.kill(child.pid, 'SIGTERM');
    rmSync(infoPath, { force: true });
    throw error;
  }
}

async function finish(mode: string, outcome: string): Promise<void> {
  const state: State = JSON.parse(readFileSync(`${privateDir}/lifecycle.json`, 'utf8'));
  let valid = false;
  let stopped = false;
  try {
    const info = await readInfo(state.infoPath);
    const report: Report = existsSync(reportFile)
      ? JSON.parse(readFileSync(reportFile, 'utf8'))
      : { count: 0, authOk: false };
    const protectedConfig = [state.infoPath, `${home}/config.toml`].every((file) => {
      const stat = statSync(file);
      return stat.uid === 0 && (stat.mode & 0o022) === 0;
    });
    valid =
      alive(state.proxy) &&
      info.pid === state.proxy.pid &&
      protectedConfig &&
      configHash() === state.configHash &&
      lifecyclePassed(
        mode,
        outcome,
        report,
        process.env.FIXTURE_OUTPUT ?? '',
        Number(process.hrtime.bigint() - BigInt(state.startedAt)) / 1e6,
      );
    const response = await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
      signal: AbortSignal.timeout(3000),
    });
    for (let attempt = 0; attempt < 60 && alive(state.proxy); attempt++) await delay(50);
    stopped = response.ok && !alive(state.proxy);
  } finally {
    // 異常時も自分が開始した同一プロセスだけを停止する。公式shutdownの失敗は合格にしない。
    for (const child of [state.proxy, state.backend])
      if (alive(child)) process.kill(child.pid, 'SIGTERM');
    rmSync(state.infoPath, { force: true });
  }
  console.log(
    JSON.stringify({ stage: 'official-action-lifecycle', mode, result: valid, shutdown: stopped }),
  );
  if (!valid || !stopped) throw new Error('official Action/proxy lifecycle failed');
}

if (import.meta.main) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw new Error('requires disposable Linux root');
  const [command, mode, extra] = process.argv.slice(2);
  if (!['complete', 'reject'].includes(mode ?? '')) throw new Error('invalid fixture mode');
  if (command === 'serve') await serve(mode);
  else if (command === 'prepare' && /^\d+$/.test(extra ?? '')) await prepare(mode, extra);
  else if (command === 'finish') await finish(mode, extra ?? '');
  else throw new Error('invalid fixture command');
}
