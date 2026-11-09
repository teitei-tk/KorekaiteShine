import { createLiveConnection } from '../src/server/live-connection.ts';

import { audioUsagePeriods, usageReservations } from '@korekaite/database/usage';
import { createEvaluationWorker } from '../../evaluation/src/worker.ts';
import { expect, test, vi } from 'vitest';
import { interviews, evaluationInputs, transcriptFragments } from '@korekaite/database';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
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
  let now = 10;
  let handlers!: LiveHandlers;
  let resolveClosed!: (value: LiveClosed) => void;
  const closed = new Promise<LiveClosed>((resolve) => {
    resolveClosed = resolve;
  });
  let closes = 0;
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
      now: () => now,
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
        handlers = callbacks;
        return {
          ready: Promise.resolve('upstream'),
          closed,
          sendAudio: () => true,
          request: () => true,
          abort: () => {},
          close: () => {
            closes += 1;
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
    await handlers.onReady('upstream');
    expect((await session.state()).status).toBe('active');
    now = 1010;
    const jobId = await session.finish();
    expect(jobId).toBe('00000000-0000-4000-8000-000000000001');
    expect(await session.finish()).toBe(jobId);
    expect(closes).toBe(1);
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
    let evaluations = 0;
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
      now: () => now,
      newId: () => '00000000-0000-4000-8000-000000000002',
      generate: async (saved) => {
        evaluations += 1;
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
    let acknowledgements = 0;
    let retries = 0;
    const message = {
      id: 'message',
      body: { schemaVersion: 1 as const, jobId },
      ack: () => {
        acknowledgements += 1;
      },
      retry: () => {
        retries += 1;
      },
    };
    await worker.queue({ queue: 'unexpected', messages: [message] }, env);
    expect(retries).toBe(1);
    expect(evaluations).toBe(0);
    await worker.queue({ queue: 'evaluation', messages: [message] }, env);
    await worker.queue({ queue: 'evaluation', messages: [{ ...message, id: 'redelivery' }] }, env);
    expect(acknowledgements).toBe(2);
    expect(evaluations).toBe(1);
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
  let now = 1010;
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
      now: () => now,
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
      activeMs: 1000,
      deadline: 61010,
      transcriptIncomplete: true,
      streamGeneration: null,
    });
    now = 61010;
    expect(await createInterviewSession(options).recover()).toMatchObject({ status: 'ended' });
    const [input] = await database.db.select().from(evaluationInputs);
    expect(input.inputJson.transcriptIncomplete).toBe(true);
    expect(input.inputJson.interview.activeMs).toBe(1000);
  } finally {
    database.close();
  }
});

test('一時停止で上流を閉じ、保存済み原文で再開して古い接続の音声を拒否する', async () => {
  const database = createTestDatabase();
  let now = 10;
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
      now: () => now,
      apiKey: 'fixture-key',
      responsesModel: 'test-model',
      voice: 'marin',
      evaluation,
      newJobId: () => '00000000-0000-4000-8000-000000000001',
      connect: (options, handlers) => {
        callbacks.push(handlers);
        contexts.push(JSON.stringify(options.session.input));
        let resolve!: (result: LiveClosed) => void;
        const closed = new Promise<LiveClosed>((done) => {
          resolve = done;
        });
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
    now = 1010;
    expect(await session.pause()).toMatchObject({
      status: 'paused',
      activeMs: 1000,
      streamGeneration: null,
    });
    expect(await session.sendAudio(initial.generation, new Uint8Array(2))).toBe(false);
    now = 2010;
    const resumed = await session.start();
    expect(contexts[1]).toContain('比較しました。');
    await callbacks[1].onReady('second');
    expect(await session.sendAudio(initial.generation, new Uint8Array(2))).toBe(false);
    expect(await session.sendAudio(resumed.generation, new Uint8Array(2))).toBe(true);
    callbacks[1].onAudio(new Uint8Array(480), 10);
    expect(await session.playback(resumed.generation, 11)).toBe(false);
    expect(await session.playback(resumed.generation, 10)).toBe(true);
    now = 3010;
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
  let now = 10;
  let callbacks!: LiveHandlers;
  let resolve!: (value: LiveClosed) => void;
  const closed = new Promise<LiveClosed>((done) => {
    resolve = done;
  });
  let closes = 0;
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
      now: () => now,
      apiKey: 'fixture-key',
      responsesModel: 'test-model',
      voice: 'marin',
      evaluation,
      newJobId: () => '00000000-0000-4000-8000-000000000001',
      connect: (_options, handlers) => {
        callbacks = handlers;
        return {
          ready: Promise.resolve('upstream'),
          closed,
          sendAudio: () => true,
          request: () => true,
          abort: () => {},
          close: () => {
            closes += 1;
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
    await callbacks.onReady('upstream');
    now = 1200009;
    expect((await session.tick()).status).toBe('active');
    expect(closes).toBe(0);
    now = 1200020;
    expect(await session.tick()).toMatchObject({ status: 'ended', activeMs: 1200000 });
    expect(closes).toBe(1);
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
  let now = 1000;
  let handlers!: LiveHandlers;
  let resolveClosed!: (value: LiveClosed) => void;
  const closed = new Promise<LiveClosed>((resolve) => {
    resolveClosed = resolve;
  });
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
      now: () => now,
      newJobId: () => '00000000-0000-4000-8000-000000000011',
      apiKey: 'fixture',
      responsesModel: 'test-model',
      voice: 'marin',
      evaluation,
      connect: (_options, callbacks) => {
        handlers = callbacks;
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
    now = 4000;
    await handlers.onReady('upstream');
    expect((await session.state()).deadline).toBe(34000);
    await handlers.onUsage(100, false);
    expect((await session.state()).status).toBe('active');
    now = 35000;
    expect((await session.tick()).status).toBe('ended');
    expect(await database.db.select().from(audioUsagePeriods)).toMatchObject([
      { startedAt: 4000, endedAt: 34000 },
    ]);
  } finally {
    database.close();
  }
});

test('保存の応答が途絶えても欠落を示して終了し、遅れた書込みは固定入力を変更しない', async () => {
  vi.useFakeTimers();
  const database = createTestDatabase();
  const writes = await import('../src/server/repositories/interviews.ts');
  const append = writes.appendTranscript;
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = vi.spyOn(writes, 'appendTranscript').mockImplementationOnce(async (...args) => {
    await deferred;
    return append(...args);
  });
  let handlers!: LiveHandlers;
  let closed!: (result: LiveClosed) => void;
  const ended = new Promise<LiveClosed>((resolve) => {
    closed = resolve;
  });
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
        handlers = callbacks;
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
