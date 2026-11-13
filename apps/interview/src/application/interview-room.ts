import { parseEvent } from '../domain/parse-event';
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
  questionBoundaries?: boolean;
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
  const room = {
    discarded: false,
    owner: null as string | null,
    state: null as State | null,
    jobId: null as string | null,
    pending: Promise.resolve(),
    queuedBytes: 0,
    queuedEvents: 0,
    initialized: undefined as Promise<void> | undefined,
  };

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
    if (!room.state) {
      return;
    }
    const event: InterviewStateEvent = {
      type: 'state',
      interviewId: room.state.interviewId,
      status: room.state.status,
      generation: room.state.generation,
      activeMs: room.state.activeMs,
      activeSince: room.state.activeSince,
      deadline: room.state.deadline,
      updatedAt: room.state.updatedAt,
      canControl: room.owner === id && room.state.status !== 'ended',
      transcriptIncomplete: room.state.transcriptIncomplete,
      evaluationJobId: room.jobId,
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
      send(
        id,
        fragment.startsQuestion && peers.get(id)?.questionBoundaries
          ? { ...event, startsQuestion: true }
          : event,
      );
    }
  }
  const session = options.createSession({
    onDialFailure: () => {
      if (room.owner) {
        error(room.owner, null, 'AUDIO_CONNECT_FAILED');
      }
    },
    onState: async (next, acceptedJob) => {
      if (room.discarded) {
        return;
      }
      room.state = next;
      room.jobId = acceptedJob;
      await options.schedule(next);
      broadcastState();
    },
    onTranscript: transcript,
    onAudio: (generation, bytes, endOffsetMs) => {
      if (!room.owner || room.state?.status !== 'active' || room.state.generation !== generation) {
        return;
      }
      const id = room.owner;
      send(id, { type: 'audio', generation, endOffsetMs, byteLength: bytes.byteLength });
      try {
        peers.get(id)?.send(bytes.slice().buffer);
      } catch {
        void detach(id);
      }
    },
  });
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = room.pending.then(operation);
    room.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  function initialize() {
    room.initialized ??= (async () => {
      room.state = await session.recover();
      await options.schedule(room.state);
    })().catch((error: Error) => {
      room.initialized = undefined;
      throw error;
    });
    return room.initialized;
  }
  async function sync(id: string) {
    room.state = await session.state();
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
    room.state = await session.state();
    if (event.type !== 'sync' && event.generation !== room.state.generation) {
      error(id, event.commandId, 'STALE_STATE');
      sendState(id);
      return;
    }
    if (
      !['sync', 'takeover'].includes(event.type) &&
      room.owner !== id &&
      !(room.owner === null && ['start', 'resume', 'finish'].includes(event.type))
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
          (event.type === 'start' && room.state.status !== 'ready') ||
          (event.type === 'resume' && !['paused', 'reconnecting'].includes(room.state.status))
        ) {
          error(id, event.commandId, 'STALE_STATE');
          return;
        }
        room.owner = id;
        await session.start();
        break;
      case 'takeover':
        if (['ending', 'ended'].includes(room.state.status)) {
          error(id, event.commandId, 'STALE_STATE');
          return;
        }
        room.owner = null;
        broadcastState();
        await session.disconnect(room.state.generation);
        room.owner = id;
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
        // 旧接続の終了待ちにタブが切れた場合は、次の担当タブの再開に任せる。
        if (room.owner === id && peers.has(id) && !room.discarded) {
          await session.start();
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
    const wasOwner = room.owner === id;
    const generation = room.state?.generation;
    if (wasOwner) {
      room.owner = null;
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
        if (room.discarded || peers.has(id) || peers.size >= 4) {
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
      if (room.queuedEvents >= 64 || room.queuedBytes + bytes > 524288) {
        return detach(id);
      }
      room.queuedEvents += 1;
      room.queuedBytes += bytes;
      return serial(async () => {
        if (!peers.has(id)) {
          return;
        }
        const commandIdState = { commandId: null as string | null };
        try {
          if (typeof data === 'string') {
            const event = parseEvent(data);
            if (!validateInterviewClientEvent(event)) {
              error(id, null, 'INVALID_EVENT');
              return;
            }
            commandIdState.commandId = event.commandId;
            await command(id, event);
          } else {
            // PCM16の前に8byteのbig-endian float64で接続世代を付ける。
            if (data.byteLength < 10 || data.byteLength % 2 !== 0) {
              error(id, null, 'INVALID_EVENT');
              return;
            }
            const generation = new DataView(data).getFloat64(0);
            if (room.owner !== id || !Number.isSafeInteger(generation) || generation < 1) {
              error(id, null, 'NOT_OWNER');
              return;
            }
            if (!(await session.sendAudio(generation, new Uint8Array(data, 8)))) {
              room.state = await session.state();
              if (room.state.generation !== generation || room.state.status !== 'active') {
                sendState(id);
              } else {
                error(id, null, 'UNAVAILABLE');
              }
            }
          }
        } catch (cause) {
          error(
            id,
            commandIdState.commandId,
            cause instanceof AudioUsageLimitError ? 'AUDIO_USAGE_LIMIT' : 'UNAVAILABLE',
          );
        }
      }).finally(() => {
        room.queuedEvents -= 1;
        room.queuedBytes -= bytes;
      });
    },
    discard(interviewId: string) {
      room.discarded = true;
      room.owner = null;
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
      room.state = null;
    },
    detach,
    alarm: () =>
      serial(async () => {
        await initialize();
        const before = room.state;
        const next = await session.tick();
        // 期限到達による遷移はonStateで通知・予約済み。稼働確認だけなら次回を予約する。
        if (!room.discarded && room.state === before) {
          room.state = next;
          await options.schedule(next);
        }
      }),
  };
}
