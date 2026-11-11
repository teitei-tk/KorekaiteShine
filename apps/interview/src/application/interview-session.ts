import { remainingAudioMs } from '../server/repositories/audio-usage';
import { asc, eq } from 'void/db';
import { transcriptFragments, type EvaluationConfiguration } from '@korekaite/database/interviews';
import type { createPrimaryDb } from '@korekaite/database/connection';
import { canSendAudio, transitionInterview, type InterviewAction } from '../domain/interview-state';
import { createLiveConnection } from '../server/live-connection';
import {
  appendTranscript,
  loadInterview,
  saveInterviewState,
  markTranscriptIncomplete,
  recordPlayback,
} from '../server/repositories/interviews';
import { finishInterview } from '../server/repositories/finish-interview';
import { buildLiveSession, InterviewContextLimitError } from './live-session';

export class AudioUsageLimitError extends Error {}

type Options = {
  onDialFailure?(): void;
  db: ReturnType<typeof createPrimaryDb>;
  actorId: string;
  interviewId: string;
  now(): number;
  newJobId(): string;
  apiKey: string;
  responsesModel: string;
  voice: Parameters<typeof buildLiveSession>[2]['voice'];
  evaluation: EvaluationConfiguration;
  connect?: typeof createLiveConnection;
  onState?(
    state: NonNullable<Awaited<ReturnType<typeof loadInterview>>>,
    jobId: string | null,
  ): Promise<void>;
  onTranscript?(fragment: typeof transcriptFragments.$inferSelect): void;
  onAudio?(generation: number, bytes: Uint8Array, endOffsetMs: number): void;
  onUsage?(generation: number, seconds: number, final: boolean): Promise<void>;
};
type Connection = ReturnType<typeof createLiveConnection>;

// 応答が遅れた書込みも、repositoryの世代・revision照合を通った時だけ確定する。
async function awaitTranscript<T>(save: Promise<T>): Promise<T | null> {
  const timerState = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
  try {
    return await Promise.race([
      save,
      new Promise<null>((resolve) => {
        timerState.timer = setTimeout(() => resolve(null), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timerState.timer);
  }
}

// 面接ごとに一つのインスタンスをDOが所有する。上流終了待ちはDB直列化の外で行う。
export function createInterviewSession(options: Options) {
  const { db, actorId, interviewId } = options;
  const lifecycle = {
    pending: Promise.resolve() as Promise<void>,
    current: null as { connection: Connection; generation: number; settled: Promise<void> } | null,
    discarded: false,
    incomplete: false,
    outputOffsetMs: 0,
    acceptedJob: null as string | null,
  };

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = lifecycle.pending.then(operation);
    lifecycle.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function read() {
    const row = await loadInterview(db, actorId, interviewId);
    if (!row) {
      throw new Error('面接が見つかりません。');
    }
    return row;
  }
  async function transition(action: InterviewAction) {
    const row = await read();
    const next = transitionInterview(row, action, options.now());
    if (next === row || row.status === 'ended') {
      return row;
    }
    const saved = await saveInterviewState(db, actorId, next, row.revision);
    if (!saved) {
      throw new Error('面接状態の保存が競合しました。');
    }
    await options.onState?.(saved, lifecycle.acceptedJob);
    return saved;
  }
  async function finalize() {
    lifecycle.acceptedJob = await finishInterview(
      db,
      actorId,
      interviewId,
      {
        jobId: lifecycle.acceptedJob ?? options.newJobId(),
        evaluation: options.evaluation,
        transcriptIncomplete: lifecycle.incomplete,
      },
      options.now(),
    );
    if (!lifecycle.acceptedJob) {
      throw new Error('終了内容を保存できませんでした。');
    }
    await options.onState?.(await read(), lifecycle.acceptedJob);
    return lifecycle.acceptedJob;
  }

  return {
    discard() {
      lifecycle.discarded = true;
      lifecycle.current?.connection.abort();
      lifecycle.current = null;
    },
    state: () => serial(read),
    recover: () =>
      serial(async () => {
        const row = await read();
        if (lifecycle.current || row.status === 'ended') {
          return row;
        }
        if (row.streamGeneration !== null) {
          await markTranscriptIncomplete(db, actorId, interviewId, options.now());
          await transition({ type: 'disconnected', generation: row.generation });
          await transition({ type: 'closed', generation: row.streamGeneration });
        }
        const recovered = await transition({ type: 'tick' });
        if (recovered.status === 'ending') {
          await finalize();
        }
        return read();
      }),
    start: () =>
      serial(async () => {
        const row = await read();
        if (lifecycle.current || row.streamGeneration !== null) {
          throw new Error('前の音声接続の終了確認が必要です。');
        }
        if (row.status === 'ended') {
          return row;
        }
        if (row.status === 'ending') {
          await finalize();
          return read();
        }
        const fragments = await db
          .select()
          .from(transcriptFragments)
          .where(eq(transcriptFragments.interviewId, interviewId))
          .orderBy(asc(transcriptFragments.sequence));
        const session = (() => {
          try {
            return buildLiveSession(row, fragments, options);
          } catch (error) {
            if (!(error instanceof InterviewContextLimitError)) {
              throw error;
            }
            return null;
          }
        })();
        if (!session) {
          await transition({ type: 'finish' });
          await finalize();
          return read();
        }
        if ((await remainingAudioMs(db, actorId, options.now())) <= 0) {
          throw new AudioUsageLimitError('音声利用枠が不足しています。');
        }
        const connecting = await transition({ type: 'connect' });
        if (connecting.status === 'ending') {
          await finalize();
          return read();
        }
        if (lifecycle.discarded) {
          throw new Error('削除済みの面接です。');
        }
        const generation = connecting.generation;
        lifecycle.outputOffsetMs = 0;
        const connection = (options.connect ?? createLiveConnection)(
          { apiKey: options.apiKey, session },
          {
            onReady: () =>
              serial(async () => {
                const now = options.now();
                const remaining = await remainingAudioMs(db, actorId, now);
                await transition({ type: 'ready', generation, deadline: now + remaining });
              }),
            onTranscript: (event) =>
              serial(async () => {
                const saved = await awaitTranscript(
                  appendTranscript(db, actorId, {
                    interviewId,
                    fragmentId: `${interviewId}:${generation}:${event.event_id}`,
                    generation,
                    sourceEventId: event.event_id,
                    speaker: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
                    content: event.delta,
                    sourceStartMs: event.start_ms ?? null,
                    sourceEndMs: event.end_ms ?? null,
                    receivedAt: options.now(),
                  }),
                );
                if (!saved) {
                  lifecycle.incomplete = true;
                  throw new Error('文字起こしを保存できませんでした。');
                }
                options.onTranscript?.(saved);
              }),
            onAudio: (bytes, endOffsetMs) => {
              lifecycle.outputOffsetMs = endOffsetMs;
              options.onAudio?.(generation, bytes, endOffsetMs);
            },
            onUsage: async (seconds, final) => {
              await options.onUsage?.(generation, seconds, final);
            },
          },
        );
        const settled = connection.closed.then((result) =>
          serial(async () => {
            if (lifecycle.discarded) {
              return;
            }
            const before = await read();
            if (before.streamGeneration !== generation) {
              return;
            }
            if (result.reason === 'DIAL_FAILED') {
              options.onDialFailure?.();
              if (before.status === 'connecting' && before.activeMs === 0) {
                lifecycle.current = null;
                await transition({ type: 'start_failed', generation });
                return;
              }
            }
            lifecycle.incomplete ||=
              !result.complete || result.upstreamReason !== 'close_requested';
            if (lifecycle.incomplete) {
              await markTranscriptIncomplete(db, actorId, interviewId, options.now());
            }
            await transition({ type: 'disconnected', generation });
            const after = await transition({ type: 'closed', generation });
            lifecycle.current = null;
            if (after.status === 'ending') {
              await finalize();
            }
          }),
        );
        // 失敗は操作のawaitで返す。非同期の接続失敗を未処理rejectionにしない。
        void connection.ready.catch(() => {});
        void settled.catch(() => {});
        lifecycle.current = { connection, generation, settled };
        return connecting;
      }),
    sendAudio: (generation: number, bytes: Uint8Array) =>
      serial(async () => {
        const row = await read();
        return Boolean(
          lifecycle.current &&
          lifecycle.current.generation === generation &&
          canSendAudio(row, generation, options.now()) &&
          lifecycle.current.connection.sendAudio(bytes),
        );
      }),
    playback: (generation: number, audioOffsetMs: number) =>
      serial(async () => {
        if (
          !lifecycle.current ||
          lifecycle.current.generation !== generation ||
          audioOffsetMs > lifecycle.outputOffsetMs
        ) {
          return false;
        }
        return recordPlayback(db, actorId, {
          interviewId,
          generation,
          audioOffsetMs,
          receivedAt: options.now(),
        });
      }),
    request: (generation: number, operation: 'rephrase' | 'skip') =>
      serial(async () => {
        const row = await read();
        return Boolean(
          lifecycle.current &&
          lifecycle.current.generation === generation &&
          canSendAudio(row, generation, options.now()) &&
          lifecycle.current.connection.request(operation),
        );
      }),
    async tick() {
      const expired = await serial(async () => {
        const row = await transition({ type: 'tick' });
        return { ending: row.status === 'ending', active: lifecycle.current };
      });
      if (expired.ending) {
        if (expired.active) {
          void expired.active.connection.close();
          await expired.active.settled;
        }
        await serial(finalize);
      }
      return serial(read);
    },
    async disconnect(generation: number) {
      const active = await serial(async () => {
        const row = await read();
        if (row.generation !== generation) {
          return null;
        }
        await transition({ type: 'disconnected', generation });
        return lifecycle.current;
      });
      if (active) {
        void active.connection.close();
        await active.settled;
      }
      return serial(read);
    },
    async pause() {
      const active = await serial(async () => {
        await transition({ type: 'pause' });
        return lifecycle.current;
      });
      if (active) {
        void active.connection.close();
        await active.settled;
      }
      return serial(read);
    },
    async finish() {
      const active = await serial(async () => {
        await transition({ type: 'finish' });
        return lifecycle.current;
      });
      if (active) {
        void active.connection.close();
        await active.settled;
      }
      return serial(finalize);
    },
  };
}
