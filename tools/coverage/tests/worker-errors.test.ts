import { runInNewContext } from 'node:vm';
import { parse, readObject } from '../src/schema.ts';
import { assert, beforeEach, afterEach, expect, test, vi } from 'vitest';
import { readWorkerCoverage } from '../src/worker.ts';
const originalParse = JSON.parse;
const modeState = { mode: 'normal' };
class InspectorSocket extends EventTarget {
  static instances: InspectorSocket[] = [];
  closed = false;
  constructor(_url: string, options: { headers: Record<string, string> }) {
    super();
    InspectorSocket.instances.push(this);
    expect(options.headers.Origin).toBe('http://localhost');
    queueMicrotask(() => {
      if (modeState.mode === 'connect-timeout') {
        return;
      }
      this.dispatchEvent(new Event(modeState.mode === 'connect-error' ? 'error' : 'open'));
    });
  }
  send(text: string) {
    const { id, method } = readObject(parse(text));
    if (typeof id !== 'number' || typeof method !== 'string') {
      throw new TypeError('Inspector request fixtureが不正です。');
    }
    if (modeState.mode.startsWith('malformed-')) {
      const replies: Record<string, object | null> = {
        'malformed-object': null,
        'malformed-id': { id: 'bad' },
        'malformed-method': { method: 1 },
        'malformed-context': { method: 'Runtime.executionContextCreated', params: {} },
        'malformed-value': { id, result: { result: { value: 123 } } },
      };
      this.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify(replies[modeState.mode]) }),
      );
      return;
    }
    if (modeState.mode === 'reply-timeout') {
      return;
    }
    if (modeState.mode === 'close') {
      this.dispatchEvent(new CloseEvent('close', { code: 1006, reason: 'fixture' }));
      return;
    }
    if (method === 'Runtime.enable' && modeState.mode !== 'no-context') {
      this.message({ method: 'Runtime.executionContextCreated', params: { context: { id: 1 } } });
    }
    this.message({ id: id + 100 });
    if (modeState.mode === 'error') {
      this.message({ id, error: { message: 'private fixture' } });
    } else if (modeState.mode === 'exception') {
      this.message({ id, result: { exceptionDetails: { text: 'private fixture' } } });
    } else if (method === 'Runtime.evaluate' && modeState.mode === 'missing-value') {
      this.message({ id });
    } else if (method === 'Runtime.evaluate' && modeState.mode === 'invalid-snapshot') {
      this.message({ id, result: { result: { value: 'null' } } });
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
test('実行コンテキストの通知がなければ空カバレッジを返さない', async () => {
  modeState.mode = 'no-context';
  await expect(readWorkerCoverage('ws://fixture')).rejects.toThrow('実行コンテキストがありません');
  expect(
    (InspectorSocket.instances.at(-1) ?? assert.fail('必須のテスト値がありません。')).closed,
  ).toBe(true);
});
test('応答待ちの期限を超えたら収集を終了する', async () => {
  modeState.mode = 'reply-timeout';
  vi.useFakeTimers();
  const rejected = expect(readWorkerCoverage('ws://fixture')).rejects.toThrow(
    'Worker計測がタイムアウト',
  );
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(
    (InspectorSocket.instances.at(-1) ?? assert.fail('必須のテスト値がありません。')).closed,
  ).toBe(true);
});
test('接続待ちの期限を超えたら収集を終了する', async () => {
  modeState.mode = 'connect-timeout';
  vi.useFakeTimers();
  const rejected = expect(readWorkerCoverage('ws://fixture')).rejects.toThrow(
    'Inspector接続がタイムアウト',
  );
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(
    (InspectorSocket.instances.at(-1) ?? assert.fail('必須のテスト値がありません。')).closed,
  ).toBe(true);
});
test('収集中の切断は未完了として拒否する', async () => {
  modeState.mode = 'close';
  await expect(readWorkerCoverage('ws://fixture')).rejects.toThrow('切断されました: 1006 fixture');
  expect(
    (InspectorSocket.instances.at(-1) ?? assert.fail('必須のテスト値がありません。')).closed,
  ).toBe(true);
});
test('Inspectorのエラー応答・評価例外を固定理由で拒否する', async () => {
  for (const scenario of ['error', 'exception']) {
    modeState.mode = scenario;
    await expect(readWorkerCoverage('ws://fixture')).rejects.toThrow('Inspector応答が失敗');
    expect(
      (InspectorSocket.instances.at(-1) ?? assert.fail('必須のテスト値がありません。')).closed,
    ).toBe(true);
  }
});

beforeEach(() => {
  modeState.mode = 'normal';
  InspectorSocket.instances = [];
  vi.stubGlobal('WebSocket', InspectorSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('Inspector接続エラーで収集を成功扱いせずソケットを閉じる', async () => {
  modeState.mode = 'connect-error';
  await expect(readWorkerCoverage('ws://fixture')).rejects.toThrow('接続できません');
  expect(
    (InspectorSocket.instances.at(-1) ?? assert.fail('必須のテスト値がありません。')).closed,
  ).toBe(true);
});

test.each([
  ['malformed-object', 'Inspector応答が不正'],
  ['malformed-id', 'Inspector応答が不正'],
  ['malformed-method', 'Inspector応答が不正'],
  ['malformed-context', 'Inspectorコンテキストが不正'],
  ['malformed-value', 'Inspector値が不正'],
  ['missing-value', 'Inspector値がありません'],
  ['invalid-snapshot', 'snapshotが不正'],
])('不正なInspector応答を拒否して接続を閉じる: %s', async (mode, message) => {
  modeState.mode = mode;
  await expect(readWorkerCoverage('ws://fixture')).rejects.toThrow(message);
  expect(InspectorSocket.instances.at(-1)?.closed).toBe(true);
});

test('WebSocketコンストラクターがソケットを返さなければ拒否する', async () => {
  vi.stubGlobal('WebSocket', new Proxy(InspectorSocket, { construct: () => ({}) }));
  await expect(readWorkerCoverage('ws://fixture')).rejects.toThrow(
    'Inspectorソケットを作成できません',
  );
});

test('別realmの例外でも収集を拒否しソケットを閉じる', async () => {
  const { stringify } = JSON;
  vi.spyOn(JSON, 'parse').mockImplementation((text) => {
    if (text === stringify({ id: 101 })) {
      throw runInNewContext('new Error("invalid inspector payload")');
    }
    const result: ReturnType<typeof parse> = originalParse(text);
    return result;
  });
  try {
    await expect(readWorkerCoverage('ws://fixture')).rejects.toThrow('invalid inspector payload');
    expect(InspectorSocket.instances.at(-1)?.closed).toBe(true);
  } finally {
    vi.restoreAllMocks();
  }
});
