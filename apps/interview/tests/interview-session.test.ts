import { createLiveConnection } from '../src/server/live-connection.ts';

import { audioUsagePeriods, usageReservations } from '@korekaite/database/usage';
import { createEvaluationWorker } from '../../evaluation/src/worker.ts';
import { expect, test, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { interviews, evaluationInputs, transcriptFragments } from '@korekaite/database';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { remainingAudioMs } from '../src/server/repositories/audio-usage';
import { createInterviewSession } from '../src/application/interview-session.ts';
import type { LiveHandlers, LiveClosed } from '../src/server/live-connection.ts';

const evaluation = {
  model: 'test-model',
  promptVersion: 'v1',
  rubricVersion: 'v1',
  instructions: '発言だけを根拠にする。',
  rubric: '架空の基準',
};

test('モック音声接続で開始し、終了中の最後の発言を保存して一度だけ評価を依頼する', async () => {
  const database = createTestDatabase();
  const nowState = { now: 10 };
  const onConnect = vi.fn<(handlers: LiveHandlers) => void>();

  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<LiveClosed>();
  const closesState = { closes: 0 };
  const events: string[] = [];
  try {
    await database.db.insert(interviews).values({
      interviewId: 'interview',
      actorId: 'actor',
      materialHash: 'hash',
      themeTitle: '構成',
      themeHeading: '判断',
      themeExcerpt: '架空の経験',
      background: '',
      status: 'ready',
      createdAt: 0,
      updatedAt: 0,
    });
    const session = createInterviewSession({
      db: database.db,
      actorId: 'actor',
      interviewId: 'interview',
      now: () => nowState.now,
      onState: async (state) => {
        events.push(state.status);
      },
      onTranscript: (fragment) => {
        events.push(fragment.content);
      },
      apiKey: 'fixture-key',
      responsesModel: 'test-model',
      voice: 'marin',
      evaluation,
      newJobId: () => '00000000-0000-4000-8000-000000000001',
      connect: (_options, callbacks) => {
        onConnect(callbacks);
        return {
          ready: Promise.resolve('upstream'),
          closed,
          sendAudio: () => true,
          request: () => true,
          abort: () => {},
          close: () => {
            closesState.closes += 1;
            void callbacks
              .onTranscript({
                type: 'session.input_transcript.delta',
                event_id: 'tail',
                start_ms: 0,
                end_ms: 1000,
                delta: '最後の回答です。',
              })
              .then(() =>
                resolveClosed({
                  complete: true,
                  reason: 'confirmed',
                  upstreamReason: 'close_requested',
                  usageSeconds: 1,
                }),
              );
            return closed;
          },
        };
      },
    });
    expect((await session.start()).status).toBe('connecting');
    const [handlers] = onConnect.mock.lastCall!;
    await handlers.onReady('upstream');
    expect((await session.state()).status).toBe('active');
    nowState.now = 1010;
    const jobId = await session.finish();
    expect(jobId).toBe('00000000-0000-4000-8000-000000000001');
    expect(await session.finish()).toBe(jobId);
    expect(closesState.closes).toBe(1);
    expect(events).toContain('active');
    expect(events.indexOf('最後の回答です。')).toBeLessThan(events.indexOf('ended'));
    expect(events.at(-1)).toBe('ended');
    const [input] = await database.db.select().from(evaluationInputs);
    expect(input.inputJson).toMatchObject({
      interview: { activeMs: 1000 },
      transcriptIncomplete: false,
      fragments: [{ content: '最後の回答です。', sequence: 1 }],
    });
    expect((await session.state()).status).toBe('ended');
    const evaluationsState = { evaluations: 0 };
    const axis = { status: 'unconfirmed', score: null, reason: '詳細は未確認です。', evidence: [] };
    const report = {
      summary: '説明の詳細を次回確認する。',
      axes: { problem: axis, alternatives: axis, reasoning: axis, action: axis, learning: axis },
      strengths: [],
      gaps: [],
      unconfirmed: [],
      practiceQuestions: [],
      consistency: [],
    };
    const worker = createEvaluationWorker({
      now: () => nowState.now,
      newId: () => '00000000-0000-4000-8000-000000000002',
      generate: async (saved) => {
        evaluationsState.evaluations += 1;
        expect(saved.fragments[0].content).toBe('最後の回答です。');
        return report;
      },
    });
    const sent: string[] = [];
    const env = {
      DB: database.binding,
      EVALUATION_QUEUE_NAME: 'evaluation',
      EVALUATION_DLQ_NAME: 'evaluation-dlq',
      EVALUATION_QUEUE: {
        send: async (body: { jobId: string }) => {
          sent.push(body.jobId);
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
      EVALUATION_DLQ: {
        send: async () => {
          throw new Error('成功時にDLQへ送ってはいけません。');
        },
      },
    };
    await worker.scheduled({}, env);
    expect(sent).toEqual([jobId]);
    const acknowledgementsContext = { acknowledgements: 0, retries: 0 };
    const message = {
      id: 'message',
      body: { schemaVersion: 1 as const, jobId },
      ack: () => {
        acknowledgementsContext.acknowledgements += 1;
      },
      retry: () => {
        acknowledgementsContext.retries += 1;
      },
    };
    await worker.queue({ queue: 'unexpected', messages: [message] }, env);
    expect(acknowledgementsContext.retries).toBe(1);
    expect(evaluationsState.evaluations).toBe(0);
    await worker.queue({ queue: 'evaluation', messages: [message] }, env);
    await worker.queue({ queue: 'evaluation', messages: [{ ...message, id: 'redelivery' }] }, env);
    expect(acknowledgementsContext.acknowledgements).toBe(2);
    expect(evaluationsState.evaluations).toBe(1);
    const attempt = database.sqlite.prepare('SELECT result_json FROM job_attempts').get()!;
    expect(JSON.parse(String(attempt.result_json))).toEqual(report);
    expect(database.sqlite.prepare('SELECT status FROM jobs').get()).toEqual({
      status: 'completed',
    });
  } finally {
    database.close();
  }
});

test('再起動で失われた接続は欠落を保存し、元の待機期限を延長せずに終了する', async () => {
  const database = createTestDatabase();
  const nowState = { now: 1010 };
  try {
    await database.db.insert(interviews).values({
      interviewId: 'interview',
      actorId: 'actor',
      materialHash: 'hash',
      themeTitle: '構成',
      themeHeading: '判断',
      themeExcerpt: '架空の経験',
      background: '',
      status: 'active',
      generation: 1,
      streamGeneration: 1,
      activeSince: 10,
      deadline: 1200010,
      createdAt: 0,
      updatedAt: 10,
    });
    const options = {
      db: database.db,
      actorId: 'actor',
      interviewId: 'interview',
      now: () => nowState.now,
      apiKey: 'fixture-key',
      responsesModel: 'test-model',
      voice: 'marin' as const,
      evaluation,
      newJobId: () => '00000000-0000-4000-8000-000000000001',
      connect: () => {
        throw new Error('復旧時に音声を自動接続してはいけません。');
      },
    };
    expect(await createInterviewSession(options).recover()).toMatchObject({
      status: 'reconnecting',
      activeMs: 0,
      deadline: 60010,
      transcriptIncomplete: true,
      streamGeneration: null,
    });
    nowState.now = 60010;
    expect(await createInterviewSession(options).recover()).toMatchObject({ status: 'ended' });
    const [input] = await database.db.select().from(evaluationInputs);
    expect(input.inputJson.transcriptIncomplete).toBe(true);
    expect(input.inputJson.interview.activeMs).toBe(0);
  } finally {
    database.close();
  }
});

test('一時停止で上流を閉じ、保存済み原文で再開して古い接続の音声を拒否する', async () => {
  const database = createTestDatabase();
  const nowState = { now: 10 };
  const callbacks: LiveHandlers[] = [];
  const contexts: string[] = [];
  try {
    await database.db.insert(interviews).values({
      interviewId: 'interview',
      actorId: 'actor',
      materialHash: 'hash',
      themeTitle: '構成',
      themeHeading: '判断',
      themeExcerpt: '架空の経験',
      background: '',
      status: 'ready',
      createdAt: 0,
      updatedAt: 0,
    });
    const session = createInterviewSession({
      db: database.db,
      actorId: 'actor',
      interviewId: 'interview',
      now: () => nowState.now,
      apiKey: 'fixture-key',
      responsesModel: 'test-model',
      voice: 'marin',
      evaluation,
      newJobId: () => '00000000-0000-4000-8000-000000000001',
      connect: (options, handlers) => {
        callbacks.push(handlers);
        contexts.push(JSON.stringify(options.session.input));

        const { promise: closed, resolve } = Promise.withResolvers<LiveClosed>();
        return {
          ready: Promise.resolve('upstream'),
          closed,
          sendAudio: () => true,
          request: () => true,
          abort: () => {},
          close: () => {
            resolve({
              complete: true,
              reason: 'confirmed',
              upstreamReason: 'close_requested',
              usageSeconds: 1,
            });
            return closed;
          },
        };
      },
    });
    const initial = await session.start();
    await callbacks[0].onReady('first');
    await callbacks[0].onTranscript({
      type: 'session.input_transcript.delta',
      event_id: 'first',
      delta: '比較しました。',
      start_ms: 0,
      end_ms: 1000,
    });
    nowState.now = 1010;
    expect(await session.pause()).toMatchObject({
      status: 'paused',
      activeMs: 1000,
      streamGeneration: null,
    });
    expect(await session.sendAudio(initial.generation, new Uint8Array(2))).toBe(false);
    nowState.now = 2010;
    const resumed = await session.start();
    expect(contexts[1]).toContain('比較しました。');
    await callbacks[1].onReady('second');
    expect(await session.sendAudio(initial.generation, new Uint8Array(2))).toBe(false);
    expect(await session.sendAudio(resumed.generation, new Uint8Array(2))).toBe(true);
    callbacks[1].onAudio(new Uint8Array(480), 10);
    expect(await session.playback(resumed.generation, 11)).toBe(false);
    expect(await session.playback(resumed.generation, 10)).toBe(true);
    nowState.now = 3010;
    expect(await session.disconnect(initial.generation)).toMatchObject({ status: 'active' });
    expect(await session.disconnect(resumed.generation)).toMatchObject({
      status: 'reconnecting',
      activeMs: 2000,
      streamGeneration: null,
    });
    await session.finish();
    const [input] = await database.db.select().from(evaluationInputs);
    expect(input.inputJson).toMatchObject({
      interview: { activeMs: 2000 },
      transcriptIncomplete: false,
      playback: [{ audioOffsetMs: 10 }],
    });
  } finally {
    database.close();
  }
});

test('面接の期限到達をアラームで処理し、ブラウザなしで評価依頼を保存する', async () => {
  const database = createTestDatabase();
  const nowState = { now: 10 };
  const onConnect = vi.fn<(handlers: LiveHandlers) => void>();

  const { promise: closed, resolve } = Promise.withResolvers<LiveClosed>();
  const closesState = { closes: 0 };
  try {
    await database.db.insert(interviews).values({
      interviewId: 'interview',
      actorId: 'actor',
      materialHash: 'hash',
      themeTitle: '構成',
      themeHeading: '判断',
      themeExcerpt: '架空の経験',
      background: '',
      status: 'ready',
      createdAt: 0,
      updatedAt: 0,
    });
    const session = createInterviewSession({
      db: database.db,
      actorId: 'actor',
      interviewId: 'interview',
      now: () => nowState.now,
      apiKey: 'fixture-key',
      responsesModel: 'test-model',
      voice: 'marin',
      evaluation,
      newJobId: () => '00000000-0000-4000-8000-000000000001',
      connect: (_options, handlers) => {
        onConnect(handlers);
        return {
          ready: Promise.resolve('upstream'),
          closed,
          sendAudio: () => true,
          request: () => true,
          abort: () => {},
          close: () => {
            closesState.closes += 1;
            resolve({
              complete: true,
              reason: 'confirmed',
              upstreamReason: 'close_requested',
              usageSeconds: 1200,
            });
            return closed;
          },
        };
      },
    });
    await session.start();
    const [handlers] = onConnect.mock.lastCall!;
    await handlers.onReady('upstream');
    nowState.now = 1200009;
    expect((await session.tick()).status).toBe('active');
    expect(closesState.closes).toBe(0);
    nowState.now = 1200020;
    expect(await session.tick()).toMatchObject({ status: 'ended', activeMs: 1200000 });
    expect(closesState.closes).toBe(1);
    expect(await database.db.select().from(evaluationInputs)).toHaveLength(1);
  } finally {
    database.close();
  }
});

test('再開する文脈が上限を超えたら接続せず原文を固定して一度だけ評価へ進む', async () => {
  const database = createTestDatabase();
  try {
    await database.db.insert(interviews).values({
      interviewId: 'large',
      actorId: 'actor',
      materialHash: 'hash',
      themeTitle: '構成',
      themeHeading: '判断',
      themeExcerpt: '架空の経験',
      background: '',
      status: 'paused',
      generation: 2,
      deadline: 300000,
      createdAt: 0,
      updatedAt: 0,
    });
    const content = '架空の長い回答'.repeat(1000);
    await database.db.insert(transcriptFragments).values({
      interviewId: 'large',
      fragmentId: 'large-fragment',
      sequence: 1,
      generation: 1,
      sourceEventId: 'source',
      speaker: 'user',
      content,
      receivedAt: 1,
    });
    const connect = vi.fn(() => {
      throw new Error('上限超過で音声へ再接続してはいけません。');
    });
    const session = createInterviewSession({
      db: database.db,
      actorId: 'actor',
      interviewId: 'large',
      now: () => 1000,
      newJobId: () => '00000000-0000-4000-8000-000000000010',
      apiKey: 'fixture',
      responsesModel: 'test-model',
      voice: 'marin',
      evaluation,
      connect,
    });
    expect((await session.start()).status).toBe('ended');
    expect((await session.start()).status).toBe('ended');
    expect(connect).not.toHaveBeenCalled();
    const inputs = await database.db.select().from(evaluationInputs);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].inputJson.fragments[0].content).toBe(content);
    expect(inputs[0].inputJson.transcriptIncomplete).toBe(false);
  } finally {
    database.close();
  }
});

test('日次上限は面接中の時刻で止まり、接続準備とAIの通知値を利用時間に足さない', async () => {
  const database = createTestDatabase();
  const nowState = { now: 1000 };
  const onConnect = vi.fn<(handlers: LiveHandlers) => void>();

  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<LiveClosed>();
  try {
    await database.db.insert(usageReservations).values({
      reservationId: 'previous',
      actorId: 'actor',
      day: '1970-01-01',
      kind: 'audio',
      amount: 3570,
      createdAt: 0,
    });
    await database.db.insert(interviews).values({
      interviewId: 'limited',
      actorId: 'actor',
      materialHash: 'hash',
      themeTitle: '構成',
      themeHeading: '判断',
      themeExcerpt: '架空の経験',
      background: '',
      status: 'ready',
      createdAt: 0,
      updatedAt: 0,
    });
    const session = createInterviewSession({
      db: database.db,
      actorId: 'actor',
      interviewId: 'limited',
      now: () => nowState.now,
      newJobId: () => '00000000-0000-4000-8000-000000000011',
      apiKey: 'fixture',
      responsesModel: 'test-model',
      voice: 'marin',
      evaluation,
      connect: (_options, callbacks) => {
        onConnect(callbacks);
        return {
          ready: Promise.resolve('upstream'),
          closed,
          sendAudio: () => true,
          request: () => true,
          abort: () => {},
          close: () => {
            resolveClosed({
              complete: true,
              reason: 'confirmed',
              upstreamReason: 'close_requested',
              usageSeconds: 15.1,
            });
            return closed;
          },
        };
      },
    });
    await session.start();
    nowState.now = 4000;
    const [handlers] = onConnect.mock.lastCall!;
    await handlers.onReady('upstream');
    expect((await session.state()).deadline).toBe(34000);
    await handlers.onUsage(100, false);
    expect((await session.state()).status).toBe('active');
    nowState.now = 35000;
    expect((await session.tick()).status).toBe('ended');
    expect(await database.db.select().from(audioUsagePeriods)).toMatchObject([
      { startedAt: 4000, endedAt: 34000 },
    ]);
  } finally {
    database.close();
  }
});

test('深夜を越える前日残量は新日の面接を早期終了させない', async () => {
  const db = createTestDatabase();
  const midnight = Temporal.Instant.from('2026-11-11T00:00:00+09:00').epochMilliseconds;
  const clock = { now: midnight - 30000 };
  const stream = {} as { handlers: LiveHandlers };
  try {
    await db.db.insert(usageReservations).values({
      reservationId: 'previous',
      actorId: 'actor',
      day: '2026-11-10',
      kind: 'audio',
      amount: 3510,
      createdAt: clock.now,
    });
    await db.db.insert(interviews).values({
      interviewId: 'midnight',
      actorId: 'actor',
      materialHash: 'h',
      themeTitle: '題',
      themeHeading: '見出し',
      themeExcerpt: '経験',
      background: '',
      status: 'ready',
      createdAt: clock.now,
      updatedAt: clock.now,
    });
    const session = createInterviewSession({
      db: db.db,
      actorId: 'actor',
      interviewId: 'midnight',
      now: () => clock.now,
      apiKey: 'fixture',
      responsesModel: 'mock',
      voice: 'marin',
      evaluation,
      newJobId: () => '00000000-0000-4000-8000-000000000001',
      connect: (_options, callbacks) => {
        stream.handlers = callbacks;
        return {
          ready: Promise.resolve('upstream'),
          closed: new Promise<LiveClosed>(() => {}),
          sendAudio: () => true,
          request: () => true,
          abort: () => {},
          close: () => new Promise<LiveClosed>(() => {}),
        };
      },
    });
    await session.start();
    await stream.handlers.onReady('upstream');
    expect((await session.state()).deadline).toBe(clock.now + 1200000);
    clock.now = midnight + 60000;
    expect((await session.tick()).status).toBe('active');
    expect(await remainingAudioMs(db.db, 'actor', clock.now)).toBe(3540000);
  } finally {
    db.close();
  }
});

test('稼働確認が途絶えた面接を再起動しても停止9分を利用枠に計上せず再接続待ちを延長しない', async () => {
  const db = createTestDatabase();
  const start = Temporal.Instant.from('2026-11-11T12:00:00+09:00').epochMilliseconds;
  const now = start + 600000;
  try {
    await db.db.insert(interviews).values({
      interviewId: 'lost',
      actorId: 'actor',
      materialHash: 'h',
      themeTitle: '題',
      themeHeading: '見出し',
      themeExcerpt: '経験',
      background: '',
      status: 'active',
      generation: 1,
      streamGeneration: 1,
      activeSince: start,
      createdAt: start,
      updatedAt: start + 60000,
      deadline: start + 1200000,
    });
    expect(await remainingAudioMs(db.db, 'actor', now)).toBe(3540000);
    const session = createInterviewSession({
      db: db.db,
      interviewId: 'lost',
      actorId: 'actor',
      now: () => now,
      apiKey: 'fixture',
      responsesModel: 'mock',
      voice: 'marin',
      evaluation,
      newJobId: () => '00000000-0000-4000-8000-000000000001',
    });
    expect(await session.recover()).toMatchObject({ status: 'ended', activeMs: 60000 });
    expect(await remainingAudioMs(db.db, 'actor', now)).toBe(3540000);
    expect(await db.db.select().from(audioUsagePeriods)).toMatchObject([
      { startedAt: start, endedAt: start + 60000 },
    ]);
  } finally {
    db.close();
  }
});

test('保存の応答が途絶えても欠落を示して終了し、遅れた書込みは固定入力を変更しない', async () => {
  vi.useFakeTimers();
  const database = createTestDatabase();
  const writes = await import('../src/server/repositories/interviews.ts');
  const append = writes.appendTranscript;

  const { promise: deferred, resolve: release } = Promise.withResolvers<void>();
  const delayed = vi.spyOn(writes, 'appendTranscript').mockImplementationOnce(async (...args) => {
    await deferred;
    return append(...args);
  });
  const onConnect = vi.fn<(handlers: LiveHandlers) => void>();

  const { promise: ended, resolve: closed } = Promise.withResolvers<LiveClosed>();
  try {
    await database.db.insert(interviews).values({
      interviewId: 'slow',
      actorId: 'actor',
      materialHash: 'hash',
      themeTitle: '構成',
      themeHeading: '本文',
      themeExcerpt: '架空',
      background: '',
      status: 'ready',
      createdAt: 0,
      updatedAt: 0,
    });
    const session = createInterviewSession({
      db: database.db,
      actorId: 'actor',
      interviewId: 'slow',
      now: () => 1000,
      newJobId: () => '00000000-0000-4000-8000-000000000012',
      apiKey: 'fixture',
      responsesModel: 'test',
      voice: 'marin',
      evaluation,
      connect: (_options, callbacks) => {
        onConnect(callbacks);
        return {
          ready: Promise.resolve('mock'),
          closed: ended,
          sendAudio: () => true,
          request: () => true,
          abort: () => {},
          close: () => {
            closed({
              complete: true,
              reason: 'confirmed',
              upstreamReason: 'close_requested',
              usageSeconds: 1,
            });
            return ended;
          },
        };
      },
    });
    await session.start();
    const [handlers] = onConnect.mock.lastCall!;
    await handlers.onReady('mock');
    const failed = vi.fn();
    void handlers
      .onTranscript({
        type: 'session.input_transcript.delta',
        event_id: 'late',
        delta: '遅い発言',
        start_ms: 0,
        end_ms: 1,
      })
      .catch(failed);
    await vi.advanceTimersByTimeAsync(0);
    expect(delayed).toHaveBeenCalledTimes(1);
    const finished = session.finish();
    await vi.advanceTimersByTimeAsync(15000);
    expect(failed).toHaveBeenCalledTimes(1);
    await finished;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect((await database.db.select().from(evaluationInputs))[0].inputJson).toMatchObject({
      transcriptIncomplete: true,
      fragments: [],
    });
    expect(await database.db.select().from(transcriptFragments)).toHaveLength(0);
  } finally {
    release();
    delayed.mockRestore();
    database.close();
    vi.useRealTimers();
  }
});

test('開始前に音声枠が尽きたら面接を開始前のまま保ち、評価を作らない', async () => {
  const database = createTestDatabase();
  try {
    await database.db.insert(usageReservations).values({
      reservationId: 'previous',
      actorId: 'actor',
      day: '1970-01-01',
      kind: 'audio',
      amount: 3600,
      createdAt: 0,
    });
    await database.db.insert(interviews).values({
      interviewId: 'waiting',
      actorId: 'actor',
      materialHash: 'hash',
      themeTitle: '構成',
      themeHeading: '判断',
      themeExcerpt: '架空',
      background: '',
      status: 'ready',
      createdAt: 0,
      updatedAt: 0,
    });
    const session = createInterviewSession({
      db: database.db,
      actorId: 'actor',
      interviewId: 'waiting',
      now: () => 1000,
      newJobId: () => crypto.randomUUID(),
      apiKey: 'fixture',
      responsesModel: 'test',
      voice: 'marin',
      evaluation,
    });
    await expect(session.start()).rejects.toThrow('音声利用枠');
    expect((await session.state()).status).toBe('ready');
    expect(await database.db.select().from(evaluationInputs)).toHaveLength(0);
  } finally {
    database.close();
  }
});

test('上流Upgrade失敗は音声枠を消費せず、同じ面接を開始前に戻す', async () => {
  const database = createTestDatabase();
  const failure = vi.fn();
  try {
    await database.db.insert(interviews).values({
      interviewId: 'dial',
      actorId: 'actor',
      materialHash: 'hash',
      themeTitle: '構成',
      themeHeading: '本文',
      themeExcerpt: '架空',
      background: '',
      status: 'ready',
      createdAt: 0,
      updatedAt: 0,
    });
    const session = createInterviewSession({
      db: database.db,
      actorId: 'actor',
      interviewId: 'dial',
      now: () => 1000,
      newJobId: () => crypto.randomUUID(),
      apiKey: 'fixture',
      responsesModel: 'test',
      voice: 'marin',
      evaluation,
      onDialFailure: failure,
      connect: (options, handlers) =>
        createLiveConnection(options, {
          ...handlers,
          dial: async () => {
            throw new Error('fixture');
          },
        }),
    });
    await session.start();
    await expect.poll(async () => (await session.state()).status).toBe('ready');
    expect(failure).toHaveBeenCalledTimes(1);
    expect(await database.db.select().from(audioUsagePeriods)).toHaveLength(0);
    expect(await database.db.select().from(evaluationInputs)).toHaveLength(0);
  } finally {
    database.close();
  }
});

async function lifecycleFixture() {
  const database = createTestDatabase();
  await database.db.insert(interviews).values({
    interviewId: 'i',
    actorId: 'actor',
    materialHash: 'hash',
    themeTitle: '題',
    themeHeading: '判断',
    themeExcerpt: '例',
    background: '',
    status: 'ready',
    createdAt: 0,
    updatedAt: 0,
  });
  const options = {
    db: database.db,
    actorId: 'actor',
    interviewId: 'i',
    now: () => 100,
    newJobId: () => crypto.randomUUID(),
    apiKey: 'fixture',
    responsesModel: 'mock',
    voice: 'marin' as const,
    evaluation,
  };

  const { promise: closed, resolve: close } = Promise.withResolvers<LiveClosed>();
  const handlers: LiveHandlers[] = [];
  const abort = vi.fn();
  const session = createInterviewSession({
    ...options,
    connect: (_, hooks) => {
      handlers.push(hooks);
      return {
        ready: Promise.resolve('s'),
        closed,
        abort,
        sendAudio: () => true,
        request: () => true,
        close: () => closed,
      };
    },
  });
  return { database, session, options, close: close, handlers, abort };
}

test('接続準備中の再起動は稼働時間を増やさず元の接続期限内で復帰する', async () => {
  const { database, session } = await lifecycleFixture();
  try {
    await database.db.update(interviews).set({
      status: 'connecting',
      generation: 1,
      streamGeneration: 1,
      deadline: 30_000,
    });
    expect(await session.recover()).toMatchObject({
      status: 'reconnecting',
      activeMs: 0,
      updatedAt: 100,
      deadline: 30_000,
      streamGeneration: null,
      transcriptIncomplete: true,
    });
  } finally {
    database.close();
  }
});

test('保存済みの終了・終了待ち・期限切れの面接を開始操作から回復する', async () => {
  for (const status of ['ending', 'ended', 'paused'] as const) {
    const { database, session } = await lifecycleFixture();
    try {
      await database.db
        .update(interviews)
        .set({ status, deadline: status === 'paused' ? 50 : null });
      expect(await session.start()).toMatchObject({ status: 'ended' });
      expect(await session.recover()).toMatchObject({ status: 'ended' });
      expect(await database.db.select().from(evaluationInputs)).toHaveLength(
        status === 'ended' ? 0 : 1,
      );
    } finally {
      database.close();
    }
  }
});

test('利用枠・状態取得・保存の競合で開始や終了の成功を返さない', async () => {
  const { database, session, options } = await lifecycleFixture();
  try {
    await expect(
      createInterviewSession({ ...options, interviewId: 'missing' }).state(),
    ).rejects.toThrow('見つかりません');
    await expect(
      createInterviewSession({ ...options, responsesModel: ' ' }).start(),
    ).rejects.toThrow('設定');
    database.sqlite.exec(
      'CREATE TRIGGER ignore_state BEFORE UPDATE ON interviews BEGIN SELECT RAISE(IGNORE); END',
    );
    await expect(session.start()).rejects.toThrow('競合');
    database.sqlite.exec('DROP TRIGGER ignore_state');
    await database.db.update(interviews).set({ status: 'ending', streamGeneration: 1 });
    await expect(session.finish()).rejects.toThrow('終了内容');
    await database.db.update(interviews).set({ status: 'ready', streamGeneration: null });
    session.discard();
    await expect(session.start()).rejects.toThrow('削除済み');
  } finally {
    database.close();
  }
});

test('開始後の重複接続を拒否し、終了済みの接続からの通知を無視する', async () => {
  for (const reason of ['discard', 'generation', 'failure'] as const) {
    const { database, session, handlers, close, abort } = await lifecycleFixture();
    try {
      expect(await session.request(1, 'skip')).toBe(false);
      await session.start();
      expect(await session.recover()).toMatchObject({ status: 'connecting' });
      await expect(session.start()).rejects.toThrow('前の音声接続');
      expect(await session.request(2, 'skip')).toBe(false);
      expect(await session.request(1, 'skip')).toBe(false);
      await handlers[0].onReady('upstream');

      // 保存済み発言に時刻がない上流実装でも原文は保持する。
      await handlers[0].onTranscript({
        type: 'session.output_transcript.delta',
        event_id: 't',
        delta: '質問',
      } as Parameters<LiveHandlers['onTranscript']>[0]);
      expect(await database.db.select().from(transcriptFragments)).toMatchObject([
        { speaker: 'assistant', sourceStartMs: null, sourceEndMs: null },
      ]);
      if (reason === 'discard') {
        session.discard();
        expect(abort).toHaveBeenCalledOnce();
      }
      if (reason === 'generation') {
        await database.db.update(interviews).set({ streamGeneration: 2 });
      }
      close({
        reason: 'DIAL_FAILED',
        usageSeconds: null,
        upstreamReason: null,
        complete: false,
      });
      await Promise.resolve();
      const state = await session.state();
      expect(state.status).toBe(reason === 'failure' ? 'reconnecting' : 'active');
    } finally {
      database.close();
    }
  }
});

test('接続参照のない復旧状態でも一時停止でき、期限到達後は評価依頼に進む', async () => {
  const { database, session } = await lifecycleFixture();
  try {
    await database.db
      .update(interviews)
      .set({ status: 'active', activeSince: 1, deadline: 200, generation: 1 });
    expect((await session.pause()).status).toBe('paused');
    await database.db.update(interviews).set({ deadline: 100 });
    expect((await session.tick()).status).toBe('ended');
  } finally {
    database.close();
  }
});

test('既定の音声接続でUpgradeが拒否された場合に開始前へ戻す', async () => {
  const { database, options } = await lifecycleFixture();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  try {
    const session = createInterviewSession(options);
    await session.start();
    await vi.waitFor(async () =>
      expect(await session.state()).toMatchObject({ status: 'ready', streamGeneration: null }),
    );
  } finally {
    vi.unstubAllGlobals();
    database.close();
  }
});

test('上流の終了待ちで面接が削除された場合は終了要求へ失敗を返す', async () => {
  const { database, session, close } = await lifecycleFixture();
  try {
    await session.start();
    const finishing = session.finish();
    await vi.waitFor(async () => expect(await session.state()).toMatchObject({ status: 'ending' }));
    await database.db.delete(interviews);
    close({
      complete: true,
      reason: 'confirmed',
      upstreamReason: 'close_requested',
      usageSeconds: 0,
    });
    await expect(finishing).rejects.toThrow('面接が見つかりません');
    expect(await database.db.select().from(evaluationInputs)).toHaveLength(0);
  } finally {
    database.close();
  }
});

test('質問操作で旧接続を終了し、遅れた発言は元世代に保存して新接続の質問から分離する', async () => {
  const { database, options } = await lifecycleFixture();
  const handlers: LiveHandlers[] = [];
  const closing: ((value: LiveClosed) => void)[] = [];
  const audio = vi.fn();
  const request = vi.fn();
  const sendAudio = vi.fn(() => true);
  const session = createInterviewSession({
    ...options,
    onAudio: audio,
    connect: (_options, hooks) => {
      handlers.push(hooks);
      const closed = new Promise<LiveClosed>((resolve) => closing.push(resolve));
      return {
        ready: Promise.resolve('stream'),
        closed,
        sendAudio,
        request,
        abort: () => {},
        close: () => closed,
      };
    },
  });
  const text = (id: string, delta: string) => ({
    type: 'session.output_transcript.delta' as const,
    event_id: id,
    delta,
    start_ms: 0,
    end_ms: 10,
  });
  try {
    const first = await session.start();
    await handlers[0].onReady('old');
    const switching = session.request(first.generation, 'skip');
    await vi.waitFor(async () =>
      expect(await session.state()).toMatchObject({
        status: 'reconnecting',
        pendingQuestionOperation: 'skip',
      }),
    );
    expect(await session.request(first.generation, 'rephrase')).toBe(false);
    await handlers[0].onTranscript(text('tail', '古い質問の末尾'));
    closing[0]({
      complete: true,
      reason: 'confirmed',
      upstreamReason: 'close_requested',
      usageSeconds: 0,
    });
    expect(await switching).toBe(true);
    expect(request).not.toHaveBeenCalled();
    const next = await session.start();
    await handlers[1].onReady('new');
    handlers[0].onAudio(new Uint8Array(480), 10);
    expect(audio).not.toHaveBeenCalled();
    await handlers[0].onTranscript(text('late', '終了後の旧入力'));
    await handlers[1].onTranscript(text('fresh', '新しい質問'));
    expect(await database.db.select().from(transcriptFragments)).toMatchObject([
      { generation: first.generation, content: '古い質問の末尾', startsQuestion: false },
      { generation: next.generation, content: '新しい質問', startsQuestion: true },
    ]);
    expect((await session.state()).pendingQuestionOperation).toBe('skip');
    handlers[1].onAudio(new Uint8Array(12000), 250);
    expect(await session.playback(next.generation, 250)).toBe(true);
    expect((await session.state()).pendingQuestionOperation).toBe('skip');
    expect(await session.sendAudio(next.generation, new Uint8Array(960))).toBe(true);
    expect(sendAudio).not.toHaveBeenCalled();
    handlers[1].onAudio(new Uint8Array(12000).fill(23), 500);
    // 続く音声が届いても、最初の可聴区間の再生確認だけで回答を解放できる。
    handlers[1].onAudio(new Uint8Array(12000).fill(23), 750);
    expect(await session.playback(next.generation, 500)).toBe(true);
    expect((await session.state()).pendingQuestionOperation).toBeNull();
    expect(await session.sendAudio(next.generation, new Uint8Array(960))).toBe(true);
    expect(sendAudio).toHaveBeenCalledOnce();
  } finally {
    database.close();
  }
});

test('見送り再開で音声が先に再生されても空白の文字だけでは確定せず、最初の本文で入力を解放する', async () => {
  const { database, session, handlers } = await lifecycleFixture();
  try {
    await database.db.update(interviews).set({ pendingQuestionOperation: 'skip' });
    const active = await session.start();
    await handlers[0].onReady('resume');
    handlers[0].onAudio(new Uint8Array(12000).fill(20), 250);
    expect(await session.playback(active.generation, 250)).toBe(true);
    await handlers[0].onTranscript({
      type: 'session.output_transcript.delta',
      event_id: 'blank',
      delta: '　 ',
      start_ms: 0,
      end_ms: 100,
    });
    expect((await session.state()).pendingQuestionOperation).toBe('skip');
    await handlers[0].onTranscript({
      type: 'session.output_transcript.delta',
      event_id: 'text',
      delta: '新しい質問です。',
      start_ms: 100,
      end_ms: 200,
    });
    expect((await session.state()).pendingQuestionOperation).toBeNull();
    expect(await database.db.select().from(transcriptFragments)).toMatchObject([
      { content: '　 ', startsQuestion: false },
      { content: '新しい質問です。', startsQuestion: true },
    ]);
  } finally {
    database.close();
  }
});
