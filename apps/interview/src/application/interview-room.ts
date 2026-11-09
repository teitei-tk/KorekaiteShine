import type {
  InterviewServerEvent,
  InterviewStateEvent,
} from '@korekaite/api-contracts/events/interview-server';
import type { InterviewClientEvent } from '@korekaite/api-contracts/events/interview-client';
import {
  validateInterviewClientEvent,
  validateInterviewServerEvent,
} from '@korekaite/api-contracts/events/validators';
import { AudioUsageLimitError, type createInterviewSession } from './interview-session';

type Session = ReturnType<typeof createInterviewSession>;
type State = Awaited<ReturnType<Session['state']>>;
type SessionOptions = Parameters<typeof createInterviewSession>[0];
type Hooks = Pick<SessionOptions, 'onState' | 'onTranscript' | 'onAudio' | 'onDialFailure'>;
type Fragment = Parameters<NonNullable<SessionOptions['onTranscript']>>[0];
export interface InterviewPeer {
  send(data: string | ArrayBuffer): void;
  close(): void;
}

export function createInterviewRoom(options: {
  createSession(hooks: Hooks): Session;
  schedule(state: State): Promise<void>;
  history(): Promise<Fragment[]>;
}) {
  const peers = new Map<string, InterviewPeer>();
  const commands = new Map<string, Map<string, string>>();
  let discarded = false;
  let owner: string | null = null;
  let state: State | null = null;
  let jobId: string | null = null;
  let pending = Promise.resolve();
  let queuedBytes = 0;
  let queuedEvents = 0;
  let initialized: Promise<void> | undefined;

  function send(id: string, event: InterviewServerEvent) {
    if (!validateInterviewServerEvent(event)) {
      throw new Error('面接イベントの生成に失敗しました。');
    }
    try {
      peers.get(id)?.send(JSON.stringify(event));
    } catch {
      void detach(id);
    }
  }
  function sendState(id: string) {
    if (!state) {
      return;
    }
    const event: InterviewStateEvent = {
      type: 'state',
      interviewId: state.interviewId,
      status: state.status,
      generation: state.generation,
      activeMs: state.activeMs,
      activeSince: state.activeSince,
      deadline: state.deadline,
      updatedAt: state.updatedAt,
      canControl: owner === id && state.status !== 'ended',
      transcriptIncomplete: state.transcriptIncomplete,
      evaluationJobId: jobId,
    };
    send(id, event);
  }
  function broadcastState() {
    for (const id of peers.keys()) {
      sendState(id);
    }
  }
  function transcript(fragment: Fragment, target?: string) {
    const event: InterviewServerEvent = {
      type: 'transcript',
      fragmentId: fragment.fragmentId,
      sequence: fragment.sequence,
      generation: fragment.generation,
      speaker: fragment.speaker,
      content: fragment.content,
      sourceStartMs: fragment.sourceStartMs,
      sourceEndMs: fragment.sourceEndMs,
    };
    for (const id of target ? [target] : peers.keys()) {
      send(id, event);
    }
  }
  const session = options.createSession({
    onDialFailure: () => {
      if (owner) {
        error(owner, null, 'AUDIO_CONNECT_FAILED');
      }
    },
    onState: async (next, acceptedJob) => {
      if (discarded) {
        return;
      }
      state = next;
      jobId = acceptedJob;
      await options.schedule(next);
      broadcastState();
    },
    onTranscript: transcript,
    onAudio: (generation, bytes, endOffsetMs) => {
      if (!owner || state?.status !== 'active' || state.generation !== generation) {
        return;
      }
      const id = owner;
      send(id, { type: 'audio', generation, endOffsetMs, byteLength: bytes.byteLength });
      try {
        peers.get(id)?.send(bytes.slice().buffer);
      } catch {
        void detach(id);
      }
    },
  });
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  function initialize() {
    initialized ??= (async () => {
      state = await session.recover();
      await options.schedule(state);
    })().catch((error: Error) => {
      initialized = undefined;
      throw error;
    });
    return initialized;
  }
  async function sync(id: string) {
    state = await session.state();
    sendState(id);
    for (const fragment of await options.history()) {
      transcript(fragment, id);
    }
  }
  function error(
    id: string,
    commandId: string | null,
    code: Extract<InterviewServerEvent, { type: 'error' }>['code'],
  ) {
    send(id, { type: 'error', commandId, code });
  }
  async function command(id: string, event: InterviewClientEvent) {
    const cache = commands.get(id)!;
    const encoded = JSON.stringify(event);
    const replay = cache.get(event.commandId);
    if (replay !== undefined) {
      if (replay !== encoded) {
        error(id, event.commandId, 'INVALID_EVENT');
        return;
      }
      sendState(id);
      send(id, { type: 'ack', commandId: event.commandId });
      return;
    }
    state = await session.state();
    if (event.type !== 'sync' && event.generation !== state.generation) {
      error(id, event.commandId, 'STALE_STATE');
      sendState(id);
      return;
    }
    if (
      !['sync', 'takeover'].includes(event.type) &&
      owner !== id &&
      !(owner === null && ['start', 'resume', 'finish'].includes(event.type))
    ) {
      error(id, event.commandId, 'NOT_OWNER');
      return;
    }
    switch (event.type) {
      case 'sync':
        await sync(id);
        break;
      case 'start':
      case 'resume':
        if (
          (event.type === 'start' && state.status !== 'ready') ||
          (event.type === 'resume' && !['paused', 'reconnecting'].includes(state.status))
        ) {
          error(id, event.commandId, 'STALE_STATE');
          return;
        }
        owner = id;
        await session.start();
        break;
      case 'takeover':
        if (['ending', 'ended'].includes(state.status)) {
          error(id, event.commandId, 'STALE_STATE');
          return;
        }
        owner = null;
        broadcastState();
        await session.disconnect(state.generation);
        owner = id;
        await session.start();
        break;
      case 'pause':
        await session.pause();
        break;
      case 'finish':
        await session.finish();
        break;
      case 'playback':
        if (!(await session.playback(event.generation, event.audioOffsetMs))) {
          error(id, event.commandId, 'INVALID_EVENT');
          return;
        }
        break;
      case 'rephrase':
      case 'skip':
        if (!(await session.request(event.generation, event.type))) {
          error(id, event.commandId, 'STALE_STATE');
          return;
        }
        break;
    }
    cache.set(event.commandId, encoded);
    if (cache.size > 100) {
      cache.delete(cache.keys().next().value!);
    }
    send(id, { type: 'ack', commandId: event.commandId });
  }
  function detach(id: string): Promise<void> {
    const peer = peers.get(id);
    peers.delete(id);
    commands.delete(id);
    try {
      peer?.close();
    } catch {
      /* 切断済みでもサーバー側の停止を進める。 */
    }
    const wasOwner = owner === id;
    const generation = state?.generation;
    if (wasOwner) {
      owner = null;
      broadcastState();
    }
    return serial(async () => {
      if (wasOwner && generation !== undefined) {
        await session.disconnect(generation);
      }
    });
  }
  return {
    async attach(id: string, peer: InterviewPeer) {
      return serial(async () => {
        await initialize();
        if (discarded || peers.has(id) || peers.size >= 4) {
          peer.close();
          throw new Error('面接の接続数が上限です。');
        }
        peers.set(id, peer);
        commands.set(id, new Map());
        await sync(id);
      });
    },
    receive(id: string, data: string | ArrayBuffer): Promise<void> {
      if (!peers.has(id)) {
        return Promise.resolve();
      }
      const bytes =
        typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
      if (bytes > (typeof data === 'string' ? 8192 : 9608)) {
        error(id, null, 'INVALID_EVENT');
        return Promise.resolve();
      }
      if (queuedEvents >= 64 || queuedBytes + bytes > 524288) {
        return detach(id);
      }
      queuedEvents += 1;
      queuedBytes += bytes;
      return serial(async () => {
        if (!peers.has(id)) {
          return;
        }
        let commandId: string | null = null;
        try {
          if (typeof data === 'string') {
            let event: object | null;
            try {
              event = JSON.parse(data);
            } catch {
              error(id, null, 'INVALID_EVENT');
              return;
            }
            if (!validateInterviewClientEvent(event)) {
              error(id, null, 'INVALID_EVENT');
              return;
            }
            commandId = event.commandId;
            await command(id, event);
          } else {
            // PCM16の前に8byteのbig-endian float64で接続世代を付ける。
            if (data.byteLength < 10 || data.byteLength % 2 !== 0) {
              error(id, null, 'INVALID_EVENT');
              return;
            }
            const generation = new DataView(data).getFloat64(0);
            if (
              owner !== id ||
              !Number.isSafeInteger(generation) ||
              generation < 1 ||
              !(await session.sendAudio(generation, new Uint8Array(data, 8)))
            ) {
              error(id, null, 'NOT_OWNER');
            }
          }
        } catch (cause) {
          error(
            id,
            commandId,
            cause instanceof AudioUsageLimitError ? 'AUDIO_USAGE_LIMIT' : 'UNAVAILABLE',
          );
        }
      }).finally(() => {
        queuedEvents -= 1;
        queuedBytes -= bytes;
      });
    },
    discard(interviewId: string) {
      discarded = true;
      owner = null;
      session.discard();
      for (const [id, peer] of peers) {
        try {
          send(id, { type: 'deleted', interviewId });
          peer.close();
        } catch {
          /* 切断済み */
        }
      }
      peers.clear();
      commands.clear();
      state = null;
    },
    detach,
    alarm: () =>
      serial(async () => {
        await initialize();
        state = await session.tick();
        await options.schedule(state);
        broadcastState();
      }),
  };
}
