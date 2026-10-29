// Linux受け入れ検査専用。本番のモデル起動・資格情報除去には使用しない。
import { openSync, closeSync, writeFileSync, unlinkSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { spawnSync } from 'node:child_process';

export type IsolationInput = {
  expectedUid: number;
  protectedFiles: string[];
  readOnlyDirectories: string[];
  parentPid: number;
  port: number;
  env: NodeJS.ProcessEnv;
};
export type IsolationReport = {
  passed: boolean;
  checks: { name: string; passed: boolean; observation?: string }[];
  pidNamespace?: string;
};

function denied(action: () => void): boolean {
  try {
    action();
    return false;
  } catch (error) {
    // ENOENTなどfixtureの欠落を「アクセス拒否」の証拠にしない。
    return (
      error instanceof Error &&
      'code' in error &&
      ['EACCES', 'EPERM', 'EROFS'].includes(String(error.code))
    );
  }
}

async function networkDenied(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (passed: boolean) => {
      socket.destroy();
      resolve(passed);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(['EACCES', 'EPERM', 'ENETUNREACH', 'ECONNREFUSED'].includes(error.code ?? '')),
    );
    // タイムアウトだけでは拒否の証拠にしない。外側の検査器がlistenerの稼働を確認する。
    socket.setTimeout(2000, () => finish(false));
  });
}

export async function probeIsolation(input: IsolationInput): Promise<IsolationReport> {
  const checks: IsolationReport['checks'] = [
    { name: 'uid', passed: input.expectedUid > 0 && process.getuid?.() === input.expectedUid },
    {
      name: 'credential-environment',
      passed: ![
        'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
        'ACTIONS_ID_TOKEN_REQUEST_URL',
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'OPENAI_API_KEY',
        'CODEX_HOME',
      ].some((key) => Object.hasOwn(input.env, key)),
    },
  ];
  for (const [index, file] of input.protectedFiles.entries()) {
    checks.push({
      name: `protected-file-${index}`,
      passed: denied(() => closeSync(openSync(file, 'r'))),
    });
  }
  for (const [index, directory] of input.readOnlyDirectories.entries()) {
    const file = join(directory, `.isolation-${randomUUID()}`);
    checks.push({
      name: `read-only-directory-${index}`,
      passed: denied(() => {
        writeFileSync(file, 'harmless isolation fixture', { flag: 'wx' });
        unlinkSync(file);
      }),
    });
  }
  for (const name of ['environ', 'mem']) {
    let observation = 'readable';
    let passed = false;
    try {
      closeSync(openSync(`/proc/${input.parentPid}/${name}`, 'r'));
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      observation = ['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'ESRCH'].includes(code)
        ? code
        : 'other-error';
      passed = ['EACCES', 'EPERM', 'EROFS'].includes(code);
    }
    checks.push({ name: `parent-${name}`, passed, observation });
  }
  const sudo = spawnSync('/usr/bin/sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 2000 });
  checks.push({ name: 'sudo', passed: !sudo.error && sudo.status !== null && sudo.status !== 0 });
  checks.push({ name: 'network', passed: await networkDenied(input.port) });
  let pidNamespace: string | undefined;
  try {
    const value = readlinkSync('/proc/self/ns/pid');
    if (/^pid:\[\d+\]$/.test(value)) pidNamespace = value;
  } catch {
    /* 非Linuxや不可視の場合も、隔離成功の根拠にはしない。 */
  }
  return { passed: checks.every((check) => check.passed), checks, pidNamespace };
}

export function requireIsolationReport(text: string, names: string[]): void {
  const report: Partial<IsolationReport> & { stage?: string } = JSON.parse(text);
  if (
    !report ||
    report.stage !== 'sandbox' ||
    report.passed !== true ||
    !Array.isArray(report.checks) ||
    report.checks.length !== names.length ||
    report.checks.some(
      (check) => !check || typeof check.name !== 'string' || check.passed !== true,
    ) ||
    new Set(report.checks.map((check) => check.name)).size !== names.length ||
    names.some((name) => !report.checks?.some((check) => check.name === name))
  ) {
    throw new Error('missing or failed isolation checks');
  }
}
