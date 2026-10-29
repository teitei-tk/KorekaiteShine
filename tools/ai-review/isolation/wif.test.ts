import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticateProxy, type Launch } from './wif.ts';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const env = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-request-secret',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
  OPENAI_WIF_AUDIENCE: 'https://api.openai.com/v1',
  OPENAI_IDENTITY_PROVIDER_ID: 'idp_fixture',
  OPENAI_SERVICE_ACCOUNT_ID: 'user-fixture',
};
function fixture(mode: 'ready' | 'failure' | 'wrong-pid' | 'no-shutdown') {
  const directory = mkdtempSync(join(tmpdir(), 'wif-probe-'));
  directories.push(directory);
  const info = join(directory, 'server.json');
  let child: ReturnType<typeof spawn>;
  const launch: Launch = (...args) => {
    const [command, argv, options] = args;
    expect(command).toBe('/usr/local/bin/codex-responses-api-proxy');
    expect(argv).toContain('--github-oidc');
    expect(JSON.stringify(args)).not.toContain(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
    expect(options?.env).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' });
    // 模擬プロセスはstdin一致時だけreadyにする。HTTPは終了要求しか受け付けない。
    const source = `
      const fs = require('node:fs');
      let input = '';
      process.stdin.on('data', x => input += x);
      process.stdin.on('end', () => {
        if (input !== 'test-request-secret\\n') process.exit(9);
        if (${JSON.stringify(mode)} === 'failure') process.exit(7);
        const server = require('node:http').createServer((req, res) => {
          if (req.method !== 'GET' || req.url !== '/shutdown') process.exit(8);
          res.setHeader('Connection', 'close');
          res.end('ok');
          if (${JSON.stringify(mode)} !== 'no-shutdown') server.close();
        });
        server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(info)}, JSON.stringify({
          pid: ${JSON.stringify(mode)} === 'wrong-pid' ? 1 : process.pid,
          port: server.address().port,
        })));
      });
    `;
    child = spawn(process.execPath, ['-e', source], options);
    return child;
  };
  return { info, launch, child: () => child };
}
describe('公式プロキシだけによる認証検証', () => {
  it('要求トークンをパイプだけで渡し、ready後に隔離検査し、GET shutdownで終了する', async () => {
    const f = fixture('ready');
    let inspected = false;
    await authenticateProxy(
      env,
      f.info,
      () => {
        inspected = true;
      },
      2000,
      f.launch,
    );
    expect(inspected).toBe(true);
    expect(f.child().exitCode).toBe(0);
  });
  for (const mode of ['failure', 'wrong-pid', 'no-shutdown'] as const) {
    it(`${mode}を成功扱いせず、開始した子を停止する`, async () => {
      const f = fixture(mode);
      await expect(authenticateProxy(env, f.info, () => {}, 300, f.launch)).rejects.toThrow();
      expect(f.child().exitCode !== null || f.child().signalCode !== null).toBe(true);
    });
  }
  it('隔離検査失敗時も公式終了を試み、検証は失敗にする', async () => {
    const f = fixture('ready');
    await expect(
      authenticateProxy(
        env,
        f.info,
        () => {
          throw new Error('isolation');
        },
        2000,
        f.launch,
      ),
    ).rejects.toThrow();
    expect(f.child().exitCode).toBe(0);
  });
});
