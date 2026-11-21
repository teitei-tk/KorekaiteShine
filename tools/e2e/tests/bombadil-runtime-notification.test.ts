import type * as ChildProcessModule from 'node:child_process';
import { ChildProcess } from 'node:child_process';
import { expect, test, vi } from 'vitest';
import { launchRuntime } from '../bombadil/processes.ts';

const mocks = vi.hoisted(() => ({ fork: vi.fn<typeof ChildProcessModule.fork>() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcessModule>()),
  fork: mocks.fork,
}));

test('ランタイム通知はローカルURLだけを受理し、不正URLでも例外を外へ漏らさず失敗を返す', async () => {
  for (const message of [
    { type: 'ready', url: 'http://127.0.0.1:4321/' },
    { type: 'ready', url: 'not a URL' },
    { type: 'ready', url: 'https://127.0.0.1:4321/' },
    { type: 'ready', url: 'http://example.com/' },
    { type: 'ready', url: 'http://127.0.0.1:4321/practice' },
    { type: 'ready', url: 'http://user@127.0.0.1:4321/' },
    { type: 'ready', url: 'http://:password@127.0.0.1:4321/' },
    { type: 'ready', url: 1 },
    { type: 'error' },
    null,
  ]) {
    const child = new ChildProcess();
    mocks.fork.mockReturnValueOnce(child);
    const runtime = launchRuntime({
      fixturePath: '/fixture.json',
      temporaryDirectory: '/temporary',
    });
    const outcome = runtime.result
      .then((url) => ({ url }))
      .catch((error: Error) => ({ error: error.message }));
    try {
      expect(() => child.emit('message', message)).not.toThrow();
      expect(await outcome).toEqual(
        message?.url === 'http://127.0.0.1:4321/'
          ? { url: 'http://127.0.0.1:4321' }
          : { error: '探索用ランタイムの起動通知が不正です。' },
      );
    } finally {
      child.emit('close', 0, null);
      await runtime.stop();
    }
  }
});
