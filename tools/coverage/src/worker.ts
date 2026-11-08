import type { SourceCoverageData } from '@vitest/istanbul-lib-instrument';

interface InspectorReply {
  id?: number;
  method?: string;
  params?: { context: { id: number } };
  error?: { message: string };
  result?: { result: { value: string }; exceptionDetails?: { text: string } };
}

/** ローカルInspectorのみを使い、アプリのHTTP入口へ収集経路を追加しない。 */
export async function readWorkerCoverage(
  url: string,
  epoch?: { value: string; start?: boolean },
): Promise<Record<string, SourceCoverageData>> {
  // Node.js 26のWebSocketInit拡張はDOM側のコンストラクター型に含まれない。
  const NodeWebSocket = WebSocket as typeof WebSocket & {
    new (url: string, options: { headers: Record<string, string> }): WebSocket;
  };
  const socket = new NodeWebSocket(url, { headers: { Origin: 'http://localhost' } });
  let contextId: number | undefined;
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const message: InspectorReply = JSON.parse(String(event.data));
    if (message.method === 'Runtime.executionContextCreated') {
      contextId = message.params!.context.id;
    }
  });
  const request = (method: string, params = {}) =>
    new Promise<InspectorReply>((resolve, reject) => {
      const id = ++sequence;
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('message', receive);
        socket.removeEventListener('close', close);
      };
      const receive = (event: MessageEvent) => {
        const message: InspectorReply = JSON.parse(String(event.data));
        if (message.id !== id || message.method) {
          return;
        }
        cleanup();
        if (message.error || message.result?.exceptionDetails) {
          reject(new Error(`Worker計測のInspector応答が失敗しました: ${method}`));
        } else {
          resolve(message);
        }
      };
      const close = (event: CloseEvent) => {
        cleanup();
        reject(
          new Error(
            `Worker計測中にInspectorが切断されました: ${event.code} ${event.reason} (${method})`,
          ),
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Worker計測がタイムアウトしました: ${method}`));
      }, 5000);
      socket.addEventListener('message', receive);
      socket.addEventListener('close', close);
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Worker計測のInspector接続がタイムアウトしました')),
        5000,
      );
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
    if (contextId === undefined) {
      throw new Error('Worker計測の実行コンテキストがありません');
    }
    const reply = await request('Runtime.evaluate', {
      expression: `JSON.stringify({ epoch: ${epoch?.start ? `(globalThis.__korekaiteCoverageEpoch = ${JSON.stringify(epoch.value)})` : 'globalThis.__korekaiteCoverageEpoch'}, data: globalThis.__coverage__ ?? {} })`,
      returnByValue: true,
      contextId,
    });
    const snapshot = JSON.parse(reply.result!.result.value) as {
      epoch?: string;
      data: Record<string, SourceCoverageData>;
    };
    if (epoch && snapshot.epoch !== epoch.value) {
      throw new Error('Workerが再生成され、計測カウンターが失われています');
    }
    await request('Runtime.disable');
    return snapshot.data;
  } finally {
    socket.close();
  }
}
