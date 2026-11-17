import { object, parse, readCoverageDictionary } from './schema.ts';
import type { SourceCoverageData } from '@vitest/istanbul-lib-instrument';
type Reply = { id?: number; method?: string; contextId?: number; failure: boolean; value?: string };
function readReply(text: string): Reply {
  const value = parse(text);
  if (
    !object(value) ||
    (value.id !== undefined && typeof value.id !== 'number') ||
    (value.method !== undefined && typeof value.method !== 'string')
  ) {
    throw new Error('Worker計測のInspector応答が不正です。');
  }
  const context =
    object(value.params) && object(value.params.context) ? value.params.context.id : undefined;
  if (value.method === 'Runtime.executionContextCreated' && typeof context !== 'number') {
    throw new Error('Worker計測のInspectorコンテキストが不正です。');
  }
  const result = object(value.result) ? value.result : null;
  const payload = result !== null && object(result.result) ? result.result.value : undefined;
  if (payload !== undefined && typeof payload !== 'string') {
    throw new Error('Worker計測のInspector値が不正です。');
  }
  return {
    ...(typeof value.id === 'number' ? { id: value.id } : {}),
    ...(typeof value.method === 'string' ? { method: value.method } : {}),
    ...(typeof context === 'number' ? { contextId: context } : {}),
    failure: value.error !== undefined || result?.exceptionDetails !== undefined,
    ...(typeof payload === 'string' ? { value: payload } : {}),
  };
}
/** ローカルInspectorのみを使い、アプリのHTTP入口へ収集経路を追加しない。 */
export async function readWorkerCoverage(
  url: string,
  epoch?: { value: string; start?: boolean },
): Promise<Record<string, SourceCoverageData>> {
  // Node26独自のheaders引数をDOM型へのcastなしに渡し、生成結果を検証する。
  const constructed: unknown = Reflect.construct(WebSocket, [
    url,
    { headers: { Origin: 'http://localhost' } },
  ]);
  if (!(constructed instanceof WebSocket)) {
    throw new TypeError('Inspectorソケットを作成できません。');
  }
  const socket = constructed;
  const state: { contextId?: number; sequence: number } = { sequence: 0 };
  const request = (method: string, params: object = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const id = ++state.sequence;
      const lifecycle: { timer?: ReturnType<typeof setTimeout> } = {};
      function cleanup() {
        clearTimeout(lifecycle.timer);
        socket.removeEventListener('message', receive);
        socket.removeEventListener('close', close);
      }
      function receive(event: MessageEvent) {
        try {
          const message = readReply(String(event.data));
          if (message.contextId !== undefined) {
            state.contextId = message.contextId;
          }
          if (message.id !== id || message.method !== undefined) {
            return;
          }
          cleanup();
          if (message.failure) {
            reject(new Error(`Worker計測のInspector応答が失敗しました: ${method}`));
          } else {
            resolve(message);
          }
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      function close(event: CloseEvent) {
        cleanup();
        reject(
          new Error(
            `Worker計測中にInspectorが切断されました: ${event.code} ${event.reason} (${method})`,
          ),
        );
      }
      lifecycle.timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Worker計測がタイムアウトしました: ${method}`));
      }, 5000);
      socket.addEventListener('message', receive);
      socket.addEventListener('close', close);
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Worker計測のInspector接続がタイムアウトしました'));
      }, 5000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('Worker計測のInspectorに接続できません'));
        },
        { once: true },
      );
    });
    await request('Runtime.enable');
    if (state.contextId === undefined) {
      throw new Error('Worker計測の実行コンテキストがありません');
    }
    const reply = await request('Runtime.evaluate', {
      expression: `JSON.stringify({ epoch: ${epoch?.start === true ? `(globalThis.__korekaiteCoverageEpoch = ${JSON.stringify(epoch.value)})` : 'globalThis.__korekaiteCoverageEpoch'}, data: globalThis.__coverage__ ?? {} })`,
      returnByValue: true,
      contextId: state.contextId,
    });
    if (reply.value === undefined) {
      throw new Error('Worker計測のInspector値がありません。');
    }
    const snapshot = parse(reply.value);
    if (!object(snapshot)) {
      throw new Error('Worker計測のsnapshotが不正です。');
    }
    if (epoch !== undefined && snapshot.epoch !== epoch.value) {
      throw new Error('Workerが再生成され、計測カウンターが失われています');
    }
    const data = readCoverageDictionary(snapshot.data);
    await request('Runtime.disable');
    return data;
  } finally {
    socket.close();
  }
}
