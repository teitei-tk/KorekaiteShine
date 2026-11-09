import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync, chownSync, cpSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { executeRuntime } from './runtime.ts';
import { artifactFixture } from './tests/helpers/artifact.ts';
it('公式終了APIで停止しなければ待機上限後に停止し失敗を記録する', async () => {
  vi.mocked(fetch).mockImplementation(
    async (url) => new Response(null, { status: String(url).endsWith('/shutdown') ? 500 : 403 }),
  );
  expect(await executeRuntime('finish', '/fixture/artifact', 'success', reportEnv)).toBe(false);
  expect(process.kill).toHaveBeenCalledWith(12345, 'SIGKILL');
  expect(status()).toMatchObject({ target: 'finish/shutdown' });
  expect(console.log).toHaveBeenCalledWith('Official WIF shutdown: failed');
});
it('起動失敗時に既に終了したプロセスへkillを送らない', async () => {
  fixture.alive = false;
  expect(await executeRuntime('start', '', '', reportEnv)).toBe(false);
  expect(process.kill).not.toHaveBeenCalled();
  expect(status()).toMatchObject({ target: 'start/isolation' });
});
it('隔離検査中にプロキシが拒否応答を返さなくなったら失敗する', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }));
  expect(await executeRuntime('finish', '/fixture/artifact', 'success', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'finish/isolation' });
});
it('sandboxの検査が非ゼロ終了なら成果物を保存しない', async () => {
  const outside = {
    pid: 0,
    output: [],
    stdout: JSON.stringify({ pidNamespace: 'pid:[100]', checks: [{ name: 'uid', passed: true }] }),
    stderr: '',
    status: 0,
    signal: null,
  };
  vi.mocked(spawnSync)
    .mockReturnValueOnce(outside)
    .mockReturnValueOnce({ ...outside, status: 1 });
  expect(await executeRuntime('finish', '/fixture/artifact', 'success', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'finish/isolation' });
});
it('外側の検査で資格情報の読取りが成功したら拒否する', async () => {
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 0,
    output: [],
    stdout: JSON.stringify({
      pidNamespace: 'pid:[100]',
      checks: [{ name: 'protected-file-0', passed: false }],
    }),
    stderr: '',
    status: 0,
    signal: null,
  });
  expect(await executeRuntime('finish', '/fixture/artifact', 'success', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'finish/isolation' });
  expect(spawnSync).toHaveBeenCalledTimes(1);
});
it('外側のUID検査を起動できなければ隔離成功にしない', async () => {
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 0,
    output: [],
    stdout: '',
    stderr: '',
    status: null,
    signal: null,
  });
  expect(await executeRuntime('finish', '/fixture/artifact', 'success', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'finish/isolation' });
});

const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  alive: true,
  owner: 0,
  infoPid: 12345,
  noRunner: false,
  outputFile: true,
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  cpSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  chownSync: vi.fn(),
  rmSync: vi.fn(),
  appendFileSync: vi.fn(),
  existsSync: () => false,
  readFileSync: vi.fn((path: string) => {
    const value = fixture.files.get(path);
    if (value === undefined) {
      throw new Error('private fixture: missing file');
    }
    return value;
  }),
  writeFileSync: vi.fn((path: string, text: string) => {
    fixture.files.set(path, text);
  }),
  lstatSync: vi.fn(
    (path: string) =>
      ({
        uid: fixture.owner,
        mode: 0o644,
        isSymbolicLink: () => false,
        isFile: () => fixture.outputFile,
        isDirectory: () => ['/opt/ai-review/pr', '/opt/ai-review/context'].includes(path),
      }) as Stats,
  ),
  readdirSync: vi.fn((path: string) =>
    path === '/proc' ? (fixture.noRunner ? [] : ['101', '102', 'self']) : ['file'],
  ),
  readlinkSync: vi.fn(() => 'pid:[100]'),
}));
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));
vi.mock('./wif.ts', () => ({ authenticate: vi.fn(async () => {}) }));
vi.mock('./isolation/wif.ts', () => ({ wifProxyArgs: vi.fn(() => ['fixture']) }));
vi.mock('./isolation/lifecycle.ts', () => ({
  start: vi.fn(() => 12345),
  identity: vi.fn(() => ({ pid: 12345, start: '1' })),
  alive: vi.fn(() => fixture.alive),
  readInfo: vi.fn(async () => ({ pid: fixture.infoPid, port: 43210 })),
}));

const root = '/opt/ai-review',
  home = '/home/ai-review/.codex';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const reportEnv = {
  GITHUB_RUN_ID: '20',
  GITHUB_RUN_ATTEMPT: '1',
  AI_REVIEW_JOB: 'generate',
  AI_REVIEW_REPORT: '/fixture/status.json',
  GITHUB_STEP_SUMMARY: '/fixture/summary',
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.files.clear();
  fixture.alive = true;
  fixture.owner = 0;
  fixture.infoPid = 12345;
  fixture.noRunner = false;
  fixture.outputFile = true;
  const { metadata, review, origin } = artifactFixture();
  const metadataText = JSON.stringify(metadata);
  fixture.files.set('/fixture/metadata.json', metadataText);
  fixture.files.set(`${root}/private/metadata.json`, metadataText);
  fixture.files.set(`${home}/config.toml`, 'trusted config');
  fixture.files.set(`${home}/tmp/review.json`, JSON.stringify(review));
  fixture.files.set('/proc/101/comm', 'Runner.Worker\n');
  fixture.files.set(
    `${root}/private/state.json`,
    JSON.stringify({
      proxy: { pid: 12345, start: '1' },
      infoPath: `${home}/20.json`,
      configHash: hash('trusted config'),
      metadataHash: hash(metadataText),
      origin,
    }),
  );
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    fixture.alive = false;
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('GITHUB_RUN_ID', '20');
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
  vi.stubEnv('GITHUB_SHA', origin.sha);
  vi.stubEnv('GITHUB_OUTPUT', '/fixture/output');
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    output: [],
    stdout: JSON.stringify({
      stage: 'sandbox',
      passed: true,
      pidNamespace: 'pid:[100]',
      checks: [{ name: 'uid', passed: true }],
    }),
    stderr: '',
    status: 0,
    signal: null,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/shutdown')) {
        fixture.alive = false;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 403 });
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function status() {
  return JSON.parse(fixture.files.get('/fixture/status.json') ?? '{}');
}
it('固定診断の保存に失敗しても生の例外を表示しない', async () => {
  vi.mocked(writeFileSync).mockImplementationOnce(() => {
    throw new Error('private fixture');
  });
  expect(await executeRuntime('invalid', '', '', reportEnv)).toBe(false);
  expect(console.error).toHaveBeenCalledWith('固定診断の保存に失敗しました。');
  expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('private fixture'));
});
it('結果が通常ファイルでなければ成果物を保存しない', async () => {
  fixture.outputFile = false;
  expect(await executeRuntime('finish', '/fixture/artifact', 'success', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'finish/output' });
});
it('Action未完了でも終了APIと後処理を実行する', async () => {
  expect(await executeRuntime('finish', '/fixture/artifact', 'failure', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'finish/action' });
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:43210/shutdown', expect.any(Object));
  expect(rmSync).toHaveBeenCalledWith(home + '/20.json', { force: true });
});
it('実runnerを確認できなければ検査を成功扱いしない', async () => {
  fixture.noRunner = true;
  expect(await executeRuntime('finish', '/fixture/artifact', 'success', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'finish/isolation' });
  expect(spawnSync).not.toHaveBeenCalled();
});
it('プロキシ情報のPID不一致を隔離成功にしない', async () => {
  fixture.infoPid = 54321;
  expect(await executeRuntime('finish', '/fixture/artifact', 'success', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'finish/shutdown' });
  expect(process.kill).toHaveBeenCalledWith(12345, 'SIGKILL');
});
it('設定ハッシュが変わった場合は成果物を保存せず終了する', async () => {
  fixture.files.set(home + '/config.toml', 'changed');
  expect(await executeRuntime('finish', '/fixture/artifact', 'success', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'finish/isolation' });
  expect(appendFileSync).not.toHaveBeenCalledWith('/fixture/output', expect.any(String));
});
it('初期交換のPIDが違えば起動プロセスを停止し情報を削除する', async () => {
  fixture.infoPid = 54321;
  expect(await executeRuntime('start', '', '', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'start/proxy' });
  expect(process.kill).toHaveBeenCalledWith(12345, 'SIGKILL');
  expect(rmSync).toHaveBeenCalledWith(home + '/20.json', { force: true });
});
it('生成元SHAが不正ならプロキシ起動前に停止する', async () => {
  vi.stubEnv('GITHUB_SHA', 'invalid');
  expect(await executeRuntime('start', '', '', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'start/origin' });
  expect(spawnSync).not.toHaveBeenCalled();
});
it('未知のruntime操作はpreflightで停止し機密例外を表示しない', async () => {
  expect(await executeRuntime('invalid', '', '', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'runtime/preflight' });
  expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('private fixture'));
});
it('finishは成果物を保存して公式終了APIで停止する', async () => {
  expect(await executeRuntime('finish', '/fixture/artifact', 'success', reportEnv)).toBe(true);
  expect(appendFileSync).toHaveBeenCalledWith(
    '/fixture/output',
    'artifact=ai-review-v2-20-1\nattempt=1\n',
  );
  expect(rmSync).toHaveBeenCalledWith(home + '/20.json', { force: true });
  expect(process.kill).not.toHaveBeenCalled();
});
it('startは隔離確認後に設定ハッシュと生成元を保存する', async () => {
  expect(await executeRuntime('start', '', '', reportEnv)).toBe(true);
  const state = JSON.parse(fixture.files.get(root + '/private/state.json')!);
  expect(state.origin).toMatchObject({ run: '20', attempt: '1' });
  expect(state.configHash).toBe(hash(fixture.files.get(home + '/config.toml')!));
  expect(spawnSync).toHaveBeenCalledTimes(2);
  expect(process.kill).not.toHaveBeenCalled();
});
it('root所有化できない場合は準備段階を固定理由で記録する', async () => {
  fixture.owner = 1000;
  expect(await executeRuntime('setup', '/fixture', '/workspace', reportEnv)).toBe(false);
  expect(status()).toMatchObject({ target: 'setup/pr-owner', reason: 'EXECUTION_FAILED' });
  expect(console.error).toHaveBeenCalledWith('公式レビュー未完了: setup/pr-owner。');
});

it('setupはPRと文脈をコピーしてroot所有の信頼設定を保存する', async () => {
  expect(await executeRuntime('setup', '/fixture', '/workspace', reportEnv)).toBe(true);
  expect(cpSync).toHaveBeenCalledWith('/fixture/repository', `${root}/pr`, {
    recursive: true,
    verbatimSymlinks: true,
  });
  expect(chownSync).toHaveBeenCalledWith(`${root}/pr/file`, 0, 0);
  expect(writeFileSync).toHaveBeenCalledWith(`${root}/private/metadata.json`, expect.any(String), {
    mode: 0o600,
  });
  expect(status()).toEqual({});
});
