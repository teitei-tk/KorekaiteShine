// 廃棄できるLinux環境内だけでrootとして実行する受け入れ検査。
import { createServer, createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { probeIsolation, type IsolationInput } from '../isolation-probe.js';

if (process.platform !== 'linux' || process.getuid?.() !== 0)
  throw new Error('requires disposable Linux root environment');
const action = process.argv[2];
if (!action) throw new Error('official Action dist/main.js path required');
const server = createServer((socket) => socket.end());
const service = createServer((socket) => socket.end());
const servicePath = '/opt/ai-review-probe/service.sock';
await new Promise<void>((resolve, reject) => {
  service.once('error', reject);
  service.listen(servicePath, resolve);
});
chmodSync(servicePath, 0o600);
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listener not ready');
  // 実runnerの認証候補は開閉だけを検査する。内容や任意のファイル名はログに出さない。
  const runnerProcesses = readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => {
      try {
        return /^Runner\.(Worker|Listener)$/.test(readFileSync(`/proc/${pid}/comm`, 'utf8').trim());
      } catch {
        return false;
      }
    });
  if (process.argv[3] === 'github' && runnerProcesses.length === 0)
    throw new Error('real runner processes not found');
  const startTime = (pid: number) => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (!/^\d+$/.test(value ?? '')) throw new Error('process identity unavailable');
    return value;
  };
  const processIdentities = runnerProcesses.map((pid) => ({ pid, start: startTime(pid) }));
  const candidateFiles = [
    '/home/runner/.git-credentials',
    '/home/runner/.config/gh/hosts.yml',
    '/home/runner/.codex/auth.json',
    '/home/runner/.docker/config.json',
  ];
  for (const pid of runnerProcesses) {
    const install = dirname(dirname(readlinkSync(`/proc/${pid}/exe`)));
    for (const file of ['.credentials', '.credentials_rsaparams'])
      candidateFiles.push(join(install, file));
  }
  const runnerFiles = [...new Set(candidateFiles)].filter((file) => existsSync(file));
  const sockets = ['/var/run/docker.sock', '/run/containerd/containerd.sock'].filter(
    (file) => existsSync(file) && statSync(file).isSocket(),
  );
  const input: IsolationInput = {
    expectedUid: 2001,
    protectedFiles: ['/opt/ai-review-probe/private/dummy-token', ...runnerFiles],
    protectedProcesses: runnerProcesses,
    protectedSockets: [servicePath, ...sockets],
    readOnlyDirectories: [
      '/opt/ai-review-probe/pr',
      '/home/ai-review/.codex',
      '/tmp',
      '/home/ai-review/.codex/tmp',
    ],
    readOnlyFiles: [
      '/home/ai-review/.codex/config.toml',
      '/home/ai-review/.codex/installation_id',
      '/opt/ai-review-probe/pr/.codex/config.toml',
    ],
    parentPid: process.pid,
    port: address.port,
    env: {},
  };
  // 無制限実行で実際に検査が失敗することを先に証明する。
  const control = await probeIsolation(input);
  for (const name of [
    'uid',
    'protected-file-0',
    'read-only-directory-0',
    'network',
    'parent-environ',
    'parent-mem',
    'groups',
    'protected-socket-0',
    'read-only-file-0',
    'read-only-file-1',
    'read-only-file-2',
  ]) {
    if (control.checks.find((check) => check.name === name)?.passed !== false)
      throw new Error('negative control failed');
  }
  if (!control.pidNamespace) throw new Error('parent PID namespace unavailable');
  for (const pid of runnerProcesses)
    if (readlinkSync(`/proc/${pid}/ns/pid`) !== control.pidNamespace)
      throw new Error('runner PID namespace mismatch');
  input.parentPidNamespace = control.pidNamespace;
  writeFileSync('/opt/ai-review-probe/input.json', JSON.stringify(input), { mode: 0o444 });
  console.log('negative control: expected violations detected');
  console.log(
    JSON.stringify({
      stage: 'runner-inventory',
      processes: runnerProcesses.length,
      credentialFiles: runnerFiles.length,
      serviceSockets: sockets.length,
    }),
  );
  console.log(
    JSON.stringify({ stage: 'parent', pid: process.pid, pidNamespace: control.pidNamespace }),
  );
  const status = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      '/usr/local/bin/node',
      [
        action,
        'run-codex-exec',
        '--prompt',
        'harmless fixture',
        '--prompt-file',
        '',
        '--codex-home',
        '/home/ai-review/.codex',
        '--cd',
        '/opt/ai-review-probe/pr',
        '--extra-args',
        '',
        '--output-file',
        '',
        '--output-schema-file',
        '',
        '--output-schema',
        '',
        '--sandbox',
        'read-only',
        '--permission-profile',
        '',
        '--model',
        '',
        '--effort',
        '',
        '--safety-strategy',
        'unprivileged-user',
        '--codex-user',
        'ai-review',
      ],
      {
        env: {
          PATH: '/opt/ai-review-probe/bin:/usr/local/bin:/usr/bin:/bin',
          HOME: '/root',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'dummy-only',
          ACTIONS_ID_TOKEN_REQUEST_URL: 'dummy-only',
          GITHUB_TOKEN: 'dummy-only',
          GH_TOKEN: 'dummy-only',
          OPENAI_API_KEY: 'dummy-only',
        },
        stdio: 'inherit',
        timeout: 45000,
      },
    );
    child.once('error', reject);
    child.once('exit', resolve);
  });
  // 拒否をlistener停止による偽陽性にしない。
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
  // この親自身が子の完了を待って判定するため、親終了後のENOENTでは合格できない。
  for (const { pid, start } of processIdentities)
    if (startTime(pid) !== start) throw new Error('runner process changed during probe');
  if (status !== 0) throw new Error('isolation acceptance failed');
  console.log('official Action boundary + official CLI sandbox: passed');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => service.close(() => resolve()));
}
