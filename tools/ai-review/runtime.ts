// 公式Actionの準備・プロキシの起動/終了・成果物検証だけを担当する。モデル実行はActionに任せる。
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  chownSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  rmSync,
  appendFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { authenticate } from './wif.ts';
import { wifProxyArgs } from './isolation/wif.ts';
import { start, readInfo, identity, alive } from './isolation/lifecycle.ts';
import {
  requireIsolationReport,
  type IsolationInput,
  type IsolationReport,
} from './isolation-probe.ts';
import {
  createArtifact,
  saveArtifact,
  validateMetadata,
  type Metadata,
  type GenerationOrigin,
} from './artifact.ts';
import { digest } from './snapshot.ts';
import type { ReviewInput } from './policy.ts';
const root = '/opt/ai-review',
  worktree = `${root}/pr`,
  context = `${root}/context`,
  privateDir = `${root}/private`,
  home = '/home/ai-review/.codex';
type State = {
  proxy: { pid: number; start: string };
  infoPath: string;
  configHash: string;
  metadataHash: string;
  origin: GenerationOrigin;
};
export function protectTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chownSync(path, 0, 0);
  if (lstatSync(path).uid !== 0) throw new Error('準備ファイルの所有者不一致');
  chmodSync(path, stat.isDirectory() || stat.mode & 0o111 ? 0o755 : 0o644);
  if (stat.isDirectory()) for (const name of readdirSync(path)) protectTree(join(path, name));
}
function setup(directory: string, workspace: string): void {
  const metadata: Metadata = validateMetadata(
    JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8')),
  );
  mkdirSync(context, { recursive: true, mode: 0o755 });
  mkdirSync(privateDir, { mode: 0o700 });
  cpSync(join(directory, 'repository'), worktree, { recursive: true, verbatimSymlinks: true });
  protectTree(worktree);
  for (const name of ['request.json', 'history.json'])
    cpSync(join(directory, name), join(context, name));
  for (const name of ['schema.json', 'prompt.md'])
    cpSync(join(workspace, 'tools/ai-review', name), join(context, name));
  protectTree(context);
  writeFileSync(join(privateDir, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
  writeFileSync('/home/ai-review/.gitconfig', `[safe]\n directory = ${worktree}\n`, {
    mode: 0o644,
  });
}
const configHash = () => digest(readFileSync(`${home}/config.toml`, 'utf8'));
const metadataHash = () => digest(readFileSync(`${privateDir}/metadata.json`, 'utf8'));
async function verify(state: State): Promise<void> {
  if (
    !alive(state.proxy) ||
    configHash() !== state.configHash ||
    metadataHash() !== state.metadataHash
  )
    throw new Error('プロキシまたは信頼設定が変わりました');
  const info = await readInfo(state.infoPath);
  if (info.pid !== state.proxy.pid) throw new Error('プロキシPID不一致');
  const processes = readdirSync('/proc')
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .filter((pid) => {
      try {
        return /^Runner\.(Worker|Listener)$/.test(readFileSync(`/proc/${pid}/comm`, 'utf8').trim());
      } catch {
        return false;
      }
    });
  if (!processes.length) throw new Error('実runnerを確認できません');
  const input: IsolationInput = {
    expectedUid: 2001,
    parentPid: state.proxy.pid,
    parentPidNamespace: readlinkSync('/proc/self/ns/pid'),
    protectedProcesses: [process.pid, ...processes],
    protectedFiles: [`${privateDir}/metadata.json`],
    protectedSockets: ['/var/run/docker.sock', '/run/containerd/containerd.sock'].filter(
      existsSync,
    ),
    readOnlyDirectories: [worktree, context, home, '/tmp', `${home}/tmp`],
    readOnlyFiles: [
      `${home}/config.toml`,
      state.infoPath,
      `${context}/schema.json`,
      `${context}/prompt.md`,
    ],
    port: info.port,
    env: {},
  };
  const path = join(root, 'probe-input.json');
  writeFileSync(path, JSON.stringify(input), { mode: 0o444 });
  const script = `import{readFileSync,writeSync}from'node:fs';import{probeIsolation}from'/opt/isolation-probe.js';const i=JSON.parse(readFileSync('${path}','utf8'));i.env=process.env;const r=await probeIsolation(i);writeSync(1,JSON.stringify({stage:'sandbox',...r})+'\\n');process.exitCode=r.passed?0:1;`;
  const probeArgs = ['/usr/local/bin/node', '--input-type=module', '-e', script];
  const outside = spawnSync('/usr/bin/sudo', ['-u', 'ai-review', '--', ...probeArgs], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (outside.error || outside.status === null) throw new Error('UID隔離検査が失敗しました');
  const report: IsolationReport = JSON.parse(outside.stdout);
  if (
    report.pidNamespace !== input.parentPidNamespace ||
    report.checks.some(
      (c) =>
        c.name !== 'network' &&
        !['read-only-directory-3', 'read-only-directory-4'].includes(c.name) &&
        !c.passed,
    )
  )
    throw new Error('資格情報・信頼設定を隔離できません');
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
      worktree,
      '--',
      ...probeArgs,
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  if (inside.error || inside.status !== 0) throw new Error('読み取り専用隔離を確認できません');
  requireIsolationReport(
    inside.stdout,
    report.checks.map((c) => c.name),
  );
  const response = await fetch(`http://127.0.0.1:${info.port}/isolation`, {
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (response.status !== 403 || !alive(state.proxy))
    throw new Error('検査中にプロキシが停止しました');
}
async function begin(): Promise<void> {
  await authenticate(process.env, 'claims');
  const run = process.env.GITHUB_RUN_ID!,
    attempt = process.env.GITHUB_RUN_ATTEMPT!,
    sha = process.env.GITHUB_SHA!;
  if (!/^[1-9]\d*$/.test(run) || !/^[1-9]\d*$/.test(attempt) || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error('生成元が不正です');
  const infoPath = `${home}/${run}.json`;
  rmSync(infoPath, { force: true });
  const pid = start(
    '/usr/local/bin/codex-responses-api-proxy',
    wifProxyArgs(process.env, infoPath),
    `${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}\n`,
  );
  const proxy = identity(pid);
  try {
    const info = await readInfo(infoPath, 60000);
    if (info.pid !== pid) throw new Error('初期交換失敗');
    chmodSync(infoPath, 0o444);
    writeFileSync(
      `${home}/config.toml`,
      `model = "gpt-6-luna"\nmodel_provider = "official-proxy"\napproval_policy = "never"\nsandbox_mode = "read-only"\nsqlite_home = "${home}/tmp"\nlog_dir = "${home}/tmp"\n[model_providers.official-proxy]\nname = "Official WIF proxy"\nbase_url = "http://127.0.0.1:${info.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[projects."${worktree}"]\ntrust_level = "untrusted"\n`,
    );
    const state: State = {
      proxy,
      infoPath,
      configHash: configHash(),
      metadataHash: metadataHash(),
      origin: { run, attempt, sha },
    };
    await verify(state);
    writeFileSync(`${privateDir}/state.json`, JSON.stringify(state), { mode: 0o600 });
    console.log('Official WIF proxy and PR isolation: passed');
  } catch (error) {
    if (alive(proxy)) process.kill(proxy.pid, 'SIGKILL');
    rmSync(infoPath, { force: true });
    throw error;
  }
}
async function shutdown(state: State): Promise<boolean> {
  const info = await readInfo(state.infoPath);
  if (info.pid !== state.proxy.pid || !alive(state.proxy)) return false;
  const response = await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  for (let i = 0; i < 60 && alive(state.proxy); i++) await delay(50);
  const stopped = response.ok && !alive(state.proxy);
  console.log(`Official WIF shutdown: ${stopped ? 'passed' : 'failed'}`);
  return stopped;
}
async function finish(directory: string, outcome: string): Promise<void> {
  const state: State = JSON.parse(readFileSync(`${privateDir}/state.json`, 'utf8'));
  let stopped = false;
  try {
    try {
      if (outcome !== 'success') throw new Error('公式Action未完了');
      await verify(state);
      const file = `${home}/tmp/review.json`;
      if (!lstatSync(file).isFile()) throw new Error('結果ファイル不正');
      const review: ReviewInput = JSON.parse(readFileSync(file, 'utf8'));
      const metadata: Metadata = JSON.parse(readFileSync(`${privateDir}/metadata.json`, 'utf8'));
      const artifact = createArtifact(metadata, review, state.origin, null);
      saveArtifact(directory, artifact);
      appendFileSync(
        process.env.GITHUB_OUTPUT!,
        `artifact=ai-review-v2-${state.origin.run}-${state.origin.attempt}\nattempt=${state.origin.attempt}\n`,
      );
      console.log(
        `Validated review: findings=${artifact.review.findings.length}, checks=${artifact.review.checks?.length ?? 0}; usage unavailable, cost unknown`,
      );
    } finally {
      stopped = await shutdown(state);
    }
  } finally {
    if (alive(state.proxy)) process.kill(state.proxy.pid, 'SIGKILL');
    rmSync(state.infoPath, { force: true });
  }
  if (!stopped) throw new Error('公式終了API失敗');
}
if (import.meta.main) {
  const [command, directory, extra] = process.argv.slice(2);
  try {
    if (process.platform !== 'linux' || process.getuid?.() !== 0)
      throw new Error('Linux rootが必要です');
    if (command === 'setup') setup(directory, extra);
    else if (command === 'start') await begin();
    else if (command === 'finish') await finish(directory, extra);
    else throw new Error('コマンド不正');
  } catch {
    console.error('公式レビューの準備・生成・検証が未完了です。');
    process.exitCode = 1;
  }
}
