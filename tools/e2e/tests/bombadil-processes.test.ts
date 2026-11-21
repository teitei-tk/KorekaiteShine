import { readJsonObject } from './bombadil-test-json.ts';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { launchBrowser, launchBombadil } from '../bombadil/processes.ts';

test('外部ブラウザとCLIを直接所有し、資格情報を渡さず、通常停止を拒む双方も強制終了する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'exploration-processes-'));
  const stops: (() => Promise<void>)[] = [];
  vi.stubEnv('OPENAI_API_KEY', 'fixture-never-propagate');
  try {
    const binary = join(root, 'fixture-binary');
    await writeFile(
      binary,
      `#!${process.execPath}
const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2);
const profile=args.find(arg=>arg.startsWith('--user-data-dir='))?.split('=')[1];
const output=profile??args[args.indexOf('--output-path')+1];
fs.mkdirSync(output,{recursive:true});
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
fs.writeFileSync(path.join(output,'probe.json'),JSON.stringify({pid:process.pid,args,hasAiKey:'OPENAI_API_KEY' in process.env}));
if(profile) fs.writeFileSync(path.join(profile,'DevToolsActivePort'),'43210\\n/devtools/browser/fixture\\n');
`,
    );
    await chmod(binary, 0o700);
    const temporaryDirectory = join(root, 'temporary');
    await mkdir(temporaryDirectory);
    const browser = launchBrowser({ chrome: binary, temporaryDirectory });
    stops.push(browser.stop);
    const remoteDebugger = await browser.result;
    expect(remoteDebugger).toBe('http://127.0.0.1:43210');
    const outputDirectory = join(root, 'recording');
    const engine = launchBombadil({
      binary,
      remoteDebugger,
      specPath: 'fixture.spec.ts',
      url: 'http://127.0.0.1:12345',
      seconds: 60,
      outputDirectory,
      reproduce: '/fixture/previous',
    });
    stops.push(engine.stop);
    await expect
      .poll(() =>
        access(join(outputDirectory, 'probe.json'))
          .then(() => true)
          .catch(() => false),
      )
      .toBe(true);
    const browserProbe = readJsonObject(
      await readFile(join(temporaryDirectory, 'chrome/probe.json'), 'utf8'),
    );
    const engineProbe = readJsonObject(await readFile(join(outputDirectory, 'probe.json'), 'utf8'));
    expect(browserProbe.hasAiKey).toBe(false);
    expect(engineProbe.hasAiKey).toBe(false);
    expect(engineProbe.args).toEqual([
      'browser',
      'test-external',
      '--remote-debugger',
      remoteDebugger,
      '--create-target',
      '--output-path',
      outputDirectory,
      '--allow-url',
      'http://127.0.0.1:12345/practice',
      '--reproduce',
      '/fixture/previous',
      'http://127.0.0.1:12345/practice',
      'fixture.spec.ts',
    ]);
    await Promise.all(stops.map((stop) => stop()));
    await Promise.all(stops.map((stop) => stop()));
    expect((await engine.result).signal).toBe('SIGKILL');
    for (const pid of [browserProbe.pid, engineProbe.pid]) {
      if (typeof pid !== 'number') {
        throw new TypeError('プロセスIDが不正です。');
      }
      expect(() => process.kill(pid, 0)).toThrow();
    }
    await expect(access(join(outputDirectory, 'engine.log'))).resolves.toBeUndefined();
  } finally {
    await Promise.allSettled(stops.map((stop) => stop()));
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test('Linuxのrootコンテナでも所有ブラウザを起動できる引数を渡す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'exploration-root-browser-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!platform || !process.getuid) {
    throw new Error('この検証にはPOSIX環境が必要です。');
  }
  const uid = vi.spyOn(process, 'getuid').mockReturnValue(0);
  const state = { browser: undefined as ReturnType<typeof launchBrowser> | undefined };
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const binary = join(root, 'browser');
    await writeFile(
      binary,
      `#!${process.execPath}
const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2);
const profile=args.find(arg=>arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
fs.mkdirSync(profile,{recursive:true});
fs.writeFileSync(path.join(profile,'args.json'),JSON.stringify({args}));
fs.writeFileSync(path.join(profile,'DevToolsActivePort'),'43210\\n/devtools/browser/fixture\\n');
setInterval(()=>{},1000);
`,
    );
    await chmod(binary, 0o700);
    state.browser = launchBrowser({ chrome: binary, temporaryDirectory: root });
    await state.browser.result;
    const probe = readJsonObject(await readFile(join(root, 'chrome/args.json'), 'utf8'));
    expect(probe.args).toContain('--no-sandbox');
  } finally {
    await state.browser?.stop();
    Object.defineProperty(process, 'platform', platform);
    uid.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
