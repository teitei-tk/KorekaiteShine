// 固定版公式プロキシとActionの受け入れ検証専用。独自の認証・モデル実行器ではない。
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { authenticate } from '../wif.ts';
import { wifProxyArgs } from './wif.js';
import {
  identity,
  alive,
  readInfo,
  start,
  configHash,
  configureProxy,
  verifyProxyIsolation,
} from './lifecycle.js';

const home = '/home/ai-review/.codex';
const directory = '/opt/ai-review-probe/private/model';
const dumpDir = `${directory}/dump`;
const statePath = `${directory}/state.json`;
const schemaPath = '/opt/ai-review-probe/pr/schema.json';
const WAIT_MS = 3660000; // 固定版auth.rsのMAX_FEDERATED_TOKEN_LIFETIME=3600秒を超える。
export const schema = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['ok'] } },
  required: ['status'],
  additionalProperties: false,
};
type Usage = { input_tokens: number; output_tokens: number; total_tokens: number };
type RequestDump = {
  body?: { model?: string; text?: { format?: { type?: string; schema?: object } } };
};
type ResponseDump = { status?: number; body?: string };
type Event = {
  type?: string;
  response?: {
    status?: string;
    usage?: Partial<Usage>;
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  };
};
type State = {
  proxy: { pid: number; start: string };
  infoPath: string;
  startedAt: string;
  hash: string;
  rejected: boolean;
};
export function renewalDue(elapsedMs: number): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs >= WAIT_MS;
}
export function verifyModelEvidence(
  request: RequestDump,
  response: ResponseDump,
  output: string,
): Usage {
  const format = request.body?.text?.format;
  if (
    request.body?.model !== 'gpt-6-luna' ||
    format?.type !== 'json_schema' ||
    !isDeepStrictEqual(format.schema, schema) ||
    response.status !== 200 ||
    typeof response.body !== 'string'
  )
    throw new Error('model or schema request failed');
  const events: Event[] = response.body
    .split('\n')
    .filter((line) => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
    .map((line) => JSON.parse(line.slice(5)));
  const completed = events.filter((event) => event?.type === 'response.completed');
  if (
    completed.length !== 1 ||
    events.some((event) =>
      ['error', 'response.failed', 'response.incomplete'].includes(event?.type ?? ''),
    )
  )
    throw new Error('model did not complete');
  const result = completed[0].response;
  const texts = result?.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text');
  if (
    result?.status !== 'completed' ||
    texts?.length !== 1 ||
    !isDeepStrictEqual(JSON.parse(texts[0].text ?? ''), { status: 'ok' }) ||
    !isDeepStrictEqual(JSON.parse(output), { status: 'ok' })
  )
    throw new Error('model output does not match schema');
  const usage = result.usage;
  if (
    !usage ||
    ![usage.input_tokens, usage.output_tokens, usage.total_tokens].every(
      (value) => Number.isSafeInteger(value) && value! >= 0,
    ) ||
    usage.total_tokens !== usage.input_tokens! + usage.output_tokens!
  )
    throw new Error('missing or invalid usage');
  return usage as Usage;
}
function state(): State {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}
function save(value: State): void {
  writeFileSync(statePath, JSON.stringify(value), { mode: 0o600 });
}
function elapsed(value: State): number {
  return Number(process.hrtime.bigint() - BigInt(value.startedAt)) / 1e6;
}
function checkLive(value: State): void {
  if (!alive(value.proxy) || configHash() !== value.hash)
    throw new Error('proxy identity or config changed');
  for (const file of [value.infoPath, `${home}/config.toml`]) {
    const stat = statSync(file);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0)
      throw new Error('writable proxy configuration');
  }
}
async function prepare(runId: string): Promise<void> {
  await authenticate(process.env, 'claims');
  mkdirSync(dumpDir, { recursive: true, mode: 0o700 });
  const infoPath = `${home}/${runId}.json`;
  rmSync(infoPath, { force: true });
  const pid = start(
    '/usr/local/bin/codex-responses-api-proxy',
    [...wifProxyArgs(process.env, infoPath), '--dump-dir', dumpDir],
    `${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}\n`,
  );
  const proxy = identity(pid);
  try {
    const info = await readInfo(infoPath, 60000);
    if (info.pid !== pid || !alive(proxy)) throw new Error('WIF proxy identity mismatch');
    chmodSync(infoPath, 0o444);
    writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o444 });
    configureProxy(info.port, 'gpt-6-luna');
    const value: State = {
      proxy,
      infoPath,
      startedAt: process.hrtime.bigint().toString(),
      hash: configHash(),
      rejected: false,
    };
    verifyProxyIsolation(info, infoPath, [process.pid], [schemaPath]);
    save(value);
    console.log(
      'WIF model probe: initial exchange and isolation passed; waiting 61 minutes for expiry',
    );
  } catch (error) {
    if (alive(proxy)) process.kill(pid, 'SIGKILL');
    rmSync(infoPath, { force: true });
    throw error;
  }
}
function firewall(program: string, operation: '-I' | '-D'): void {
  // 期限切れ後の失敗注入。専用UIDのsandboxや通常の許可条件は変更しない。
  const destination = program === 'iptables' ? '127.0.0.0/8' : '::1/128';
  const result = spawnSync(
    `/usr/sbin/${program}`,
    [
      operation,
      'OUTPUT',
      '-m',
      'owner',
      '--uid-owner',
      '0',
      '!',
      '-d',
      destination,
      '-m',
      'comment',
      '--comment',
      'wif-renewal-probe',
      '-j',
      'REJECT',
    ],
    { stdio: 'ignore', timeout: 5000 },
  );
  if (result.error || result.status !== 0) throw new Error('renewal failure injection failed');
}
async function waitAndReject(): Promise<void> {
  const value = state();
  while (!renewalDue(elapsed(value))) {
    checkLive(value);
    await delay(Math.min(30000, WAIT_MS - elapsed(value)));
  }
  checkLive(value);
  const info = await readInfo(value.infoPath);
  verifyProxyIsolation(info, value.infoPath, [process.pid], [schemaPath]);
  const installed: string[] = [];
  try {
    for (const program of ['iptables', 'ip6tables']) {
      firewall(program, '-I');
      installed.push(program);
    }
    // 空の要求を1回だけ送る。交換が失敗するのでモデルAPIへは転送されない。
    const response = await fetch(`http://127.0.0.1:${info.port}/v1/responses`, {
      method: 'POST',
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(45000),
    });
    if (
      response.status !== 502 ||
      (await response.text()) !== '' ||
      readdirSync(dumpDir).filter((file) => file.endsWith('-request.json')).length !== 1 ||
      readdirSync(dumpDir).some((file) => file.endsWith('-response.json'))
    )
      throw new Error('renewal failure was not closed');
    value.rejected = true;
    save(value);
  } finally {
    for (const program of installed.reverse()) firewall(program, '-D');
  }
  await delay(2000); // 公式の初回失敗backoffは1秒。再試行は次の公式Actionの要求だけ。
  console.log('WIF model probe: expired token renewal failed closed; network restored');
}
async function finish(outcome: string): Promise<void> {
  const value = state();
  let stopped = false;
  try {
    const info = await readInfo(value.infoPath);
    try {
      checkLive(value);
      if (!value.rejected || !renewalDue(elapsed(value)) || outcome !== 'success')
        throw new Error('model acceptance incomplete');
      verifyProxyIsolation(info, value.infoPath, [process.pid], [schemaPath]);
      const files = readdirSync(dumpDir);
      const requests = files.filter((file) => file.endsWith('-request.json')).sort();
      const responses = files.filter((file) => file.endsWith('-response.json'));
      if (
        requests.length !== 2 ||
        responses.length !== 1 ||
        responses[0] !== requests[1].replace('-request.json', '-response.json')
      )
        throw new Error('unexpected model request count');
      const usage = verifyModelEvidence(
        JSON.parse(readFileSync(`${dumpDir}/${requests[1]}`, 'utf8')),
        JSON.parse(readFileSync(`${dumpDir}/${responses[0]}`, 'utf8')),
        process.env.MODEL_OUTPUT ?? '',
      );
      console.log(
        JSON.stringify({
          stage: 'wif-model',
          renewal: true,
          renewalFailureClosed: true,
          schema: true,
          modelRequests: 1,
          usage,
          cost: null,
          elapsedSeconds: Math.floor(elapsed(value) / 1000),
        }),
      );
    } finally {
      if (alive(value.proxy) && info.pid === value.proxy.pid) {
        const response = await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
        });
        for (let attempt = 0; attempt < 60 && alive(value.proxy); attempt++) await delay(50);
        stopped = response.ok && !alive(value.proxy);
        console.log(`WIF model probe: official shutdown ${stopped ? 'passed' : 'failed'}`);
      }
    }
  } finally {
    if (alive(value.proxy)) process.kill(value.proxy.pid, 'SIGKILL');
    rmSync(value.infoPath, { force: true });
  }
  if (!stopped) throw new Error('official shutdown failed');
}
if (import.meta.main) {
  try {
    if (process.platform !== 'linux' || process.getuid?.() !== 0)
      throw new Error('requires disposable Linux root');
    const [command, argument] = process.argv.slice(2);
    if (command === 'prepare' && /^\d+$/.test(argument ?? '')) await prepare(argument);
    else if (command === 'wait') await waitAndReject();
    else if (command === 'finish') await finish(argument ?? '');
    else throw new Error('invalid probe command');
  } catch {
    console.error('WIF model verification failed');
    process.exitCode = 1;
  }
}
