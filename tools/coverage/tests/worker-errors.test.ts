import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { readWorkerCoverage } from '../src/worker.ts';
test('実行コンテキストの通知がなければ空カバレッジを返さない', async () => {
  mode = 'no-context';
  await expect(readWorkerCoverage('ws://fixture')).rejects.toThrow('実行コンテキストがありません');
  expect(InspectorSocket.instances.at(-1)!.closed).toBe(true);
});
test('応答待ちの期限を超えたら収集を終了する', async () => {
  mode = 'reply-timeout';
  vi.useFakeTimers();
  const rejected = expect(readWorkerCoverage('ws://fixture')).rejects.toThrow(
    'Worker計測がタイムアウト',
  );
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(InspectorSocket.instances.at(-1)!.closed).toBe(true);
});
test('接続待ちの期限を超えたら収集を終了する', async () => {
  mode = 'connect-timeout';
  vi.useFakeTimers();
  const rejected = expect(readWorkerCoverage('ws://fixture')).rejects.toThrow(
    'Inspector接続がタイムアウト',
  );
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(InspectorSocket.instances.at(-1)!.closed).toBe(true);
});
test('収集中の切断は未完了として拒否する', async () => {
  mode = 'close';
  await expect(readWorkerCoverage('ws://fixture')).rejects.toThrow('切断されました: 1006 fixture');
  expect(InspectorSocket.instances.at(-1)!.closed).toBe(true);
});
test('Inspectorのエラー応答・評価例外を固定理由で拒否する', async () => {
  for (const scenario of ['error', 'exception']) {
    mode = scenario;
    await expect(readWorkerCoverage('ws://fixture')).rejects.toThrow('Inspector応答が失敗');
    expect(InspectorSocket.instances.at(-1)!.closed).toBe(true);
  }
});

let mode = 'normal';
class InspectorSocket extends EventTarget {
  static instances: InspectorSocket[] = [];
  closed = false;
  constructor(_url: string, options: { headers: Record<string, string> }) {
    super();
    InspectorSocket.instances.push(this);
    expect(options.headers.Origin).toBe('http://localhost');
    queueMicrotask(() => {
      if (mode === 'connect-timeout') {
        return;
      }
      this.dispatchEvent(new Event(mode === 'connect-error' ? 'error' : 'open'));
    });
  }
  send(text: string) {
    const { id, method } = JSON.parse(text);
    if (mode === 'reply-timeout') {
      return;
    }
    if (mode === 'close') {
      this.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: 'fixture' }));
      return;
    }
    if (method === 'Runtime.enable' && mode !== 'no-context') {
      this.message({ method: 'Runtime.executionContextCreated', params: { context: { id: 1 } } });
    }
    this.message({ id: id + 100 });
    if (mode === 'error') {
      this.message({ id, error: { message: 'private fixture' } });
    } else if (mode === 'exception') {
      this.message({ id, result: { exceptionDetails: { text: 'private fixture' } } });
    } else {
      this.message({ id, result: { result: { value: JSON.stringify({ data: {} }) } } });
    }
  }
  message(value: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
  close() {
    this.closed = true;
  }
}
beforeEach(() => {
  mode = 'normal';
  InspectorSocket.instances = [];
  vi.stubGlobal('WebSocket', InspectorSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('Inspector接続エラーで収集を成功扱いせずソケットを閉じる', async () => {
  mode = 'connect-error';
  await expect(readWorkerCoverage('ws://fixture')).rejects.toThrow('接続できません');
  expect(InspectorSocket.instances.at(-1)!.closed).toBe(true);
});
