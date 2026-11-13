import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { startVoiceRuntime } from '../runtime.mjs';
import { startProvider } from '../runtime-provider.mjs';
vi.mock('../runtime-provider.mjs', () => ({ startProvider: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
async function fixture() {
  const source = await mkdtemp(join(tmpdir(), 'voice-runtime-source-'));
  for (const dir of [
    'apps',
    'packages/runtime-config/src',
    'node_modules',
    'tools/local-integration/src',
    'tools/local-integration/fixtures',
    'tools/local-integration/node_modules',
  ]) {
    await mkdir(join(source, dir), { recursive: true });
  }
  await writeFile(join(source, 'tools/local-integration/package.json'), '{"type":"module"}');
  await writeFile(
    join(source, 'packages/runtime-config/src/resources.ts'),
    'export const resolveRuntime = value => value;',
  );
  await writeFile(
    join(source, 'tools/local-integration/src/runtime.ts'),
    `
 import {writeFile} from 'node:fs/promises';
 export async function startRuntime(config,mode,options){
  await writeFile(config.repositoryRoot+'/call.json',JSON.stringify({config,mode,options}));
  await writeFile(${JSON.stringify(join(source, 'root.txt'))},config.repositoryRoot);
  return {baseUrl:'http://127.0.0.1:4321',async stop(){}};
 }`,
  );
  vi.stubEnv('E2E_APP_ROOT', source);
  return source;
}
test.each(['pr', 'live'])(
  '%s は固有データで起動し、同じポートで再起動し、停止時に掃除する',
  async (profile) => {
    const source = await fixture();
    const held = Promise.resolve();
    const provider = {
      url: 'http://127.0.0.1/voice',
      stop: vi.fn(),
      rejectDials: vi.fn(),
      extendNextOpening: vi.fn(),
      omitNextOpening: vi.fn(),
      muteReplies: vi.fn(),
      silenceCurrentConnections: vi.fn(),
      holdNextQuestion: vi.fn(() => held),
    };
    startProvider.mockResolvedValue(provider);
    try {
      const runtime = await startVoiceRuntime({ profile });
      const root = await readFile(join(source, 'root.txt'), 'utf8');
      const recorded = () => readFile(join(root, 'call.json'), 'utf8').then(JSON.parse);
      const start = await recorded();
      expect(start.config.appEnv).toBe(profile === 'pr' ? 'test' : 'development');
      if (profile === 'pr') {
        expect(
          await readFile(join(root, 'tools/local-integration/fixtures/voice-interview.ts'), 'utf8'),
        ).toContain(provider.url);
        for (const operation of [
          'extendNextOpening',
          'omitNextOpening',
          'muteReplies',
          'silenceCurrentConnections',
        ]) {
          runtime[operation]();
          expect(provider[operation]).toHaveBeenCalledOnce();
        }
        expect(runtime.holdNextQuestion()).toBe(held);
        await runtime.rejectDials(true);
        expect(provider.rejectDials).toHaveBeenCalledWith(true);
      } else {
        await expect(runtime.rejectDials(true)).rejects.toThrow('PRプロファイル');
      }
      await runtime.restart();
      expect((await recorded()).options.port).toBe(4321);
      await runtime.stop();
      await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  },
);
test('起動失敗でも取得済みのサービスを停止する', async () => {
  const source = await fixture();
  try {
    const provider = { url: 'http://example.test', stop: vi.fn() };
    startProvider.mockResolvedValue(provider);
    await rm(join(source, 'packages/runtime-config/src/resources.ts'));
    await expect(startVoiceRuntime({ profile: 'pr' })).rejects.toThrow();
    expect(provider.stop).toHaveBeenCalledTimes(1);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
test('不明なプロファイルとルート欠落を起動前に拒否する', async () => {
  vi.stubEnv('E2E_APP_ROOT', '');
  await expect(startVoiceRuntime({ profile: 'pr' })).rejects.toThrow('E2E_APP_ROOT');
  await expect(startVoiceRuntime({ profile: 'unknown' })).rejects.toThrow('プロファイル');
});
