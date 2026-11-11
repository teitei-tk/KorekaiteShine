// 実WIFの初期交換だけを検証する。認証プロトコル・更新は固定版の公式プロキシに任せる。
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { authenticate } from '../wif.ts';
import { verifyProxyIsolation } from './lifecycle.ts';

export type Launch = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type Info = { pid: number; port: number };
export function wifProxyArgs(env: NodeJS.ProcessEnv, infoPath: string): string[] {
  const required = [
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'OPENAI_WIF_AUDIENCE',
    'OPENAI_IDENTITY_PROVIDER_ID',
    'OPENAI_SERVICE_ACCOUNT_ID',
  ];
  if (required.some((key) => !env[key])) {
    throw new Error('missing WIF settings');
  }
  return [
    '--github-oidc',
    '--http-shutdown',
    '--server-info',
    infoPath,
    '--oidc-audience',
    env.OPENAI_WIF_AUDIENCE!,
    '--identity-provider-id',
    env.OPENAI_IDENTITY_PROVIDER_ID!,
    '--service-account-id',
    env.OPENAI_SERVICE_ACCOUNT_ID!,
    '--github-oidc-request-url',
    env.ACTIONS_ID_TOKEN_REQUEST_URL!,
  ];
}

export async function authenticateProxy(
  env: NodeJS.ProcessEnv,
  infoPath: string,
  inspect: (info: Info) => void,
  timeoutMs = 60000,
  launch: Launch = spawn,
): Promise<void> {
  // 過去のserver-infoを初期交換成功の証拠にしない。
  rmSync(infoPath, { force: true });
  const child = launch('/usr/local/bin/codex-responses-api-proxy', wifProxyArgs(env, infoPath), {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' },
    // 標準エラーにも外部応答や資格情報を出さない。
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const failedState = { failed: false };
  child.on('error', () => {
    failedState.failed = true;
  });
  child.stdin!.on('error', () => {
    failedState.failed = true;
  });
  const running = () => child.exitCode === null && child.signalCode === null && !failedState.failed;
  const infoContext = { info: undefined as Info | undefined, stopped: false };
  try {
    child.stdin!.end(`${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}\n`);
    const deadline = Temporal.Now.instant().epochMilliseconds + timeoutMs;
    while (running() && Temporal.Now.instant().epochMilliseconds < deadline) {
      const candidateState = { candidate: undefined as Partial<Info> | undefined };
      try {
        candidateState.candidate = JSON.parse(readFileSync(infoPath, 'utf8'));
      } catch {
        /* 作成・書込み待ち */
      }
      if (
        candidateState.candidate &&
        Number.isInteger(candidateState.candidate.port) &&
        candidateState.candidate.port! > 0 &&
        candidateState.candidate.port! < 65536
      ) {
        if (candidateState.candidate.pid !== child.pid) {
          throw new Error('proxy identity mismatch');
        }
        infoContext.info = {
          pid: candidateState.candidate.pid!,
          port: candidateState.candidate.port!,
        };
        break;
      }
      await delay(25);
    }
    if (!infoContext.info || !running()) {
      throw new Error('official WIF exchange did not become ready');
    }
    chmodSync(infoPath, 0o444);
    inspect(infoContext.info);
    if (!running()) {
      throw new Error('proxy exited during isolation verification');
    }
  } finally {
    try {
      if (infoContext.info && running()) {
        // 初期交換はserver-infoより前。モデルAPIには要求を送らず、公式終了APIのみ呼ぶ。
        const response = await fetch(`http://127.0.0.1:${infoContext.info.port}/shutdown`, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
        });
        const deadline = Temporal.Now.instant().epochMilliseconds + Math.min(timeoutMs, 3000);
        while (running() && Temporal.Now.instant().epochMilliseconds < deadline) {
          await delay(25);
        }
        infoContext.stopped = response.ok && child.exitCode === 0;
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise<void>((resolve) => child.once('close', () => resolve()));
      }
      rmSync(infoPath, { force: true });
    }
  }
  if (!infoContext.stopped) {
    throw new Error('official proxy shutdown failed');
  }
}

if (import.meta.main) {
  try {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) {
      throw new Error('requires disposable Linux root');
    }
    await authenticate(process.env, 'claims');
    console.log('WIF exact claims: passed');
    const path = '/home/ai-review/.codex/wif-authentication.json';
    await authenticateProxy(process.env, path, (info) => {
      console.log('WIF initial exchange: passed');
      verifyProxyIsolation(info, path, [process.pid]);
      console.log('WIF credential isolation: passed');
    });
    console.log('WIF initial exchange, credential isolation and official shutdown: passed');
  } catch {
    // 外部応答・環境・例外内容は記録しない。失敗は認証成功として扱わない。
    console.error('WIF authentication-only verification failed');
    process.exitCode = 1;
  }
}
