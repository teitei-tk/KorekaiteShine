// 廃棄できるLinux環境内だけでrootとして実行する受け入れ検査。
import { createServer, createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { probeIsolation } from '../isolation-probe.js';

if (process.platform !== 'linux' || process.getuid?.() !== 0)
  throw new Error('requires disposable Linux root environment');
const action = process.argv[2];
if (!action) throw new Error('official Action dist/main.js path required');
const server = createServer((socket) => socket.end());
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listener not ready');
  const input = {
    expectedUid: 2001,
    protectedFiles: ['/opt/ai-review-probe/private/dummy-token'],
    readOnlyDirectories: [
      '/opt/ai-review-probe/pr',
      '/home/ai-review/.codex',
      '/tmp',
      '/home/ai-review/.codex/tmp',
    ],
    parentPid: process.pid,
    port: address.port,
    env: {},
  };
  writeFileSync('/opt/ai-review-probe/input.json', JSON.stringify(input), { mode: 0o444 });
  // 無制限実行で実際に検査が失敗することを先に証明する。
  const control = await probeIsolation(input);
  for (const name of ['uid', 'protected-file-0', 'read-only-directory-0', 'network']) {
    if (control.checks.find((check) => check.name === name)?.passed !== false)
      throw new Error('negative control failed');
  }
  console.log('negative control: expected violations detected');
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
  if (status !== 0) throw new Error('isolation acceptance failed');
  console.log('official Action boundary + official CLI sandbox: passed');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
