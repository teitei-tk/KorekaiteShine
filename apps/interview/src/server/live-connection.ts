import { parseEvent } from '../domain/parse-event';
import type { LiveStartEvent } from '@korekaite/api-contracts/events/live-start';
import type { LiveTranscriptEvent } from '@korekaite/api-contracts/events/live';
import type { LiveClientEvent } from '@korekaite/api-contracts/events/live-client';
import {
  validateLiveStartEvent,
  validateLiveServerEvent,
  validateLiveClientEvent,
} from '@korekaite/api-contracts/events/validators';

export type LiveSocket = Pick<
  WebSocket,
  'accept' | 'close' | 'readyState' | 'addEventListener' | 'removeEventListener'
> & {
  send(message: string): void;
};
export type LiveFailure =
  | 'ABORTED'
  | 'DIAL_FAILED'
  | 'CONNECT_FAILED'
  | 'START_TIMEOUT'
  | 'CLOSE_TIMEOUT'
  | 'TRANSPORT_CLOSED'
  | 'INVALID_EVENT'
  | 'UPSTREAM_ERROR'
  | 'HANDLER_FAILED'
  | 'BUFFER_LIMIT';
export interface LiveClosed {
  complete: boolean;
  reason: 'confirmed' | LiveFailure;
  upstreamReason:
    | 'close_requested'
    | 'expired'
    | 'content'
    | 'remote_hangup'
    | 'connection_lost'
    | 'unknown'
    | null;
  usageSeconds: number | null;
}
export interface LiveHandlers {
  dial?(apiKey: string, signal: AbortSignal): Promise<LiveSocket>;
  onReady(sessionId: string): Promise<void>;
  onTranscript(event: LiveTranscriptEvent): Promise<void>;
  onAudio(bytes: Uint8Array, endOffsetMs: number): void;
  onUsage(seconds: number, final: boolean): Promise<void>;
}
type Pending =
  | { kind: 'event'; data: string; bytes: number }
  | { kind: 'terminal'; reason: LiveFailure };
const known = new Set([
  'session.started',
  'session.input_transcript.delta',
  'session.output_transcript.delta',
  'session.output_audio.delta',
  'session.usage.updated',
  'session.closed',
  'error',
]);

export async function dialLiveSocket(
  apiKey: string,
  signal: AbortSignal,
  fetcher: (
    url: string,
    init: RequestInit,
  ) => Promise<{ status: number; webSocket: LiveSocket | null }> = fetch,
): Promise<LiveSocket> {
  if (!apiKey.trim() || signal.aborted) {
    throw new Error('音声接続の設定が不正です。');
  }
  try {
    const response = await fetcher('https://api.openai.com/v1/live/sessions', {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${apiKey}` },
      redirect: 'manual',
      signal,
    });
    if (response.status !== 101 || !response.webSocket) {
      throw new Error('接続を開始できません。');
    }
    return response.webSocket;
  } catch {
    throw new Error('音声AIに接続できません。');
  }
}

export function createLiveConnection(
  options: { apiKey: string; session: LiveStartEvent['session'] },
  handlers: LiveHandlers,
) {
  const start = { type: 'session.start', event_id: 'start', session: options.session };
  if (!options.apiKey.trim() || !validateLiveStartEvent(start)) {
    throw new Error('音声接続の設定が不正です。');
  }
  const startMessage = JSON.stringify(start);
  const controller = new AbortController();
  const connection = {
    socket: undefined as LiveSocket | undefined,
    started: false,
    finished: false,
    closing: false,
    terminalQueued: false,
    draining: false,
    pendingBytes: 0,
    outputBytes: 0,
    commandNumber: 0,
    usageSeconds: null as number | null,
    upstreamReason: null as LiveClosed['upstreamReason'],
    closeTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  };

  const {
    promise: ready,
    resolve: resolveReady,
    reject: rejectReady,
  } = Promise.withResolvers<string>();
  // 呼出側が接続を取り消した場合も、未購読のready拒否を残さない。
  void ready.catch(() => undefined);
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<LiveClosed>();
  const queue: Pending[] = [];
  const startTimer = setTimeout(() => terminal('START_TIMEOUT'), 30_000);

  function closeSocket() {
    if (connection.socket && connection.socket.readyState < 2) {
      try {
        connection.socket.close(1000, 'session ended');
      } catch {
        /* 接続は既に失われている。 */
      }
    }
  }
  function finish(complete: boolean, reason: LiveClosed['reason']) {
    if (connection.finished) {
      return;
    }
    connection.finished = true;
    connection.closing = true;
    clearTimeout(startTimer);
    clearTimeout(connection.closeTimer);
    controller.abort();
    connection.socket?.removeEventListener('message', receive);
    connection.socket?.removeEventListener('close', transportClosed);
    connection.socket?.removeEventListener('error', transportClosed);
    closeSocket();
    queue.length = 0;
    rejectReady(new Error('音声接続を開始できませんでした。'));
    resolveClosed({
      complete,
      reason,
      upstreamReason: connection.upstreamReason,
      usageSeconds: connection.usageSeconds,
    });
  }
  function terminal(reason: LiveFailure) {
    if (connection.finished || connection.terminalQueued) {
      return;
    }
    connection.terminalQueued = true;
    connection.closing = true;
    controller.abort();
    closeSocket();
    // 受付済みの保存を待つが、応答が途絶えた場合も接続終了を確定する。
    connection.closeTimer ??= setTimeout(() => finish(false, reason), 15_000);
    queue.push({ kind: 'terminal', reason });
    void drain();
  }
  function transportClosed() {
    terminal('TRANSPORT_CLOSED');
  }
  function receive(event: MessageEvent) {
    if (connection.finished || connection.terminalQueued) {
      return;
    }
    if (typeof event.data !== 'string') {
      terminal('INVALID_EVENT');
      return;
    }
    if (event.data.length > 262144) {
      terminal('BUFFER_LIMIT');
      return;
    }
    const bytes = new TextEncoder().encode(event.data).byteLength;
    if (bytes > 262144 || connection.pendingBytes + bytes > 1048576 || queue.length >= 256) {
      terminal('BUFFER_LIMIT');
      return;
    }
    connection.pendingBytes += bytes;
    queue.push({ kind: 'event', data: event.data, bytes });
    void drain();
  }
  async function process(data: string) {
    const candidate = parseEvent(data);
    if (!candidate || !('type' in candidate) || typeof candidate.type !== 'string') {
      finish(false, 'INVALID_EVENT');
      return;
    }
    // Responsesの内部イベント等はクライアントへ転送しない。
    if (!known.has(candidate.type)) {
      return;
    }
    if (!validateLiveServerEvent(candidate)) {
      finish(false, 'INVALID_EVENT');
      return;
    }
    switch (candidate.type) {
      case 'session.started':
        if (connection.started || connection.closing) {
          return;
        }
        await handlers.onReady(candidate.session.id);
        connection.started = true;
        clearTimeout(startTimer);
        if (!connection.terminalQueued) {
          resolveReady(candidate.session.id);
        }
        break;
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta':
        if (!connection.started || candidate.end_ms < candidate.start_ms) {
          finish(false, 'INVALID_EVENT');
          return;
        }
        await handlers.onTranscript({
          type: candidate.type,
          event_id: candidate.event_id,
          delta: candidate.delta,
          start_ms: candidate.start_ms,
          end_ms: candidate.end_ms,
        });
        break;
      case 'session.output_audio.delta': {
        if (!connection.started) {
          finish(false, 'INVALID_EVENT');
          return;
        }
        if (connection.closing) {
          return;
        }
        const binary = atob(candidate.delta);
        if (binary.length % 2 !== 0) {
          finish(false, 'INVALID_EVENT');
          return;
        }
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        connection.outputBytes += bytes.byteLength;
        handlers.onAudio(bytes, Math.floor(connection.outputBytes / 48));
        break;
      }
      case 'session.usage.updated':
        connection.usageSeconds = Math.max(connection.usageSeconds ?? 0, candidate.usage.seconds);
        await handlers.onUsage(connection.usageSeconds, false);
        break;
      case 'session.closed':
        if (!connection.started) {
          finish(false, 'INVALID_EVENT');
          return;
        }
        switch (candidate.reason) {
          case 'close_requested':
          case 'expired':
          case 'content':
          case 'remote_hangup':
          case 'connection_lost':
            connection.upstreamReason = candidate.reason;
            break;
          default:
            connection.upstreamReason = 'unknown';
        }
        connection.usageSeconds = Math.max(connection.usageSeconds ?? 0, candidate.usage.seconds);
        await handlers.onUsage(connection.usageSeconds, true);
        finish(true, 'confirmed');
        break;
      case 'error':
        finish(false, 'UPSTREAM_ERROR');
        break;
    }
  }
  async function drain() {
    if (connection.draining) {
      return;
    }
    connection.draining = true;
    try {
      while (queue.length && !connection.finished) {
        const item = queue.shift()!;
        if (item.kind === 'terminal') {
          finish(false, item.reason);
          break;
        }
        try {
          await process(item.data);
        } finally {
          connection.pendingBytes -= item.bytes;
        }
      }
    } catch {
      finish(false, 'HANDLER_FAILED');
    } finally {
      connection.draining = false;
    }
  }
  function send(message: LiveClientEvent): boolean {
    if (!validateLiveClientEvent(message)) {
      return false;
    }
    if (
      !connection.socket ||
      connection.socket.readyState !== 1 ||
      connection.finished ||
      connection.terminalQueued
    ) {
      return false;
    }
    try {
      connection.socket.send(JSON.stringify(message));
      return true;
    } catch {
      terminal('TRANSPORT_CLOSED');
      return false;
    }
  }
  void Promise.resolve()
    .then(() => (handlers.dial ?? dialLiveSocket)(options.apiKey, controller.signal))
    .then(
      (connected) => {
        connection.socket = connected;
        if (connection.finished || connection.terminalQueued) {
          try {
            connection.socket.accept();
          } finally {
            closeSocket();
          }
          return;
        }
        connection.socket.addEventListener('message', receive);
        connection.socket.addEventListener('close', transportClosed);
        connection.socket.addEventListener('error', transportClosed);
        connection.socket.accept();
        connection.socket.send(startMessage);
      },
      () => terminal('DIAL_FAILED'),
    )
    .catch(() => terminal('CONNECT_FAILED'));
  return {
    ready,
    closed,
    sendAudio(bytes: Uint8Array): boolean {
      if (
        !connection.started ||
        connection.closing ||
        bytes.byteLength === 0 ||
        bytes.byteLength % 2 !== 0 ||
        bytes.byteLength > 9600
      ) {
        return false;
      }
      return send({
        type: 'session.input_audio.append',
        audio: btoa(String.fromCharCode(...bytes)),
      });
    },
    request(operation: 'rephrase' | 'skip'): boolean {
      if (
        !connection.started ||
        connection.closing ||
        (operation !== 'rephrase' && operation !== 'skip')
      ) {
        return false;
      }
      const content =
        operation === 'rephrase'
          ? '現在の質問を、意図を変えずに分かりやすい日本語で言い換えてください。'
          : '現在の質問は見送ります。未回答を能力不足と決め付けず、同じテーマの別の観点を一つ質問してください。';
      return send({
        type: 'session.instructions.append',
        event_id: `instruction-${++connection.commandNumber}`,
        delegation_id: null,
        content,
      });
    },
    close(): Promise<LiveClosed> {
      if (connection.finished || connection.closing) {
        return closed;
      }
      connection.closing = true;
      if (!connection.started) {
        terminal('ABORTED');
        return closed;
      }
      connection.closeTimer = setTimeout(() => finish(false, 'CLOSE_TIMEOUT'), 15_000);
      send({ type: 'session.close' });
      return closed;
    },
    abort() {
      terminal('ABORTED');
    },
  };
}
