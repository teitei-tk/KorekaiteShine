import { expect, test } from 'vitest';
import { interviews } from '@korekaite/database/interviews';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { createInterviewSession } from '../src/application/interview-session.ts';
import { createInterviewRoom } from '../src/application/interview-room.ts';
import type { LiveHandlers, LiveClosed } from '../src/server/live-connection.ts';

test('操作するタブを引き継ぎ、古いタブの音声と操作を拒否して終了を通知する', async () => {
  const database = createTestDatabase();
  const handlers: LiveHandlers[] = [];
  const heard: number[] = [];
  const first: string[] = [];
  const second: string[] = [];
  let now = 1;
  let failSchedule = true;
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
    const room = createInterviewRoom({
      schedule: async () => {
        if (failSchedule) {
          failSchedule = false;
          throw new Error('一時的な保存失敗');
        }
      },
      history: async () => [],
      createSession: (hooks) =>
        createInterviewSession({
          ...hooks,
          db: database.db,
          actorId: 'actor',
          interviewId: 'interview',
          now: () => now,
          apiKey: 'fixture-key',
          responsesModel: 'mock',
          voice: 'marin',
          newJobId: () => '00000000-0000-4000-8000-000000000001',
          evaluation: {
            model: 'mock',
            promptVersion: 'v1',
            rubricVersion: 'v1',
            instructions: '架空の指示',
            rubric: '架空の基準',
          },
          connect: (_options, callbacks) => {
            handlers.push(callbacks);
            let resolve!: (value: LiveClosed) => void;
            const closed = new Promise<LiveClosed>((done) => {
              resolve = done;
            });
            return {
              ready: Promise.resolve('upstream'),
              closed,
              request: () => true,
              abort: () => {},
              sendAudio: (bytes) => {
                heard.push(bytes.byteLength);
                return true;
              },
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
        }),
    });
    await expect(room.attach('retry', { send: () => {}, close: () => {} })).rejects.toThrow(
      '一時的な保存失敗',
    );
    await room.attach('first', {
      send: (data) => {
        if (typeof data === 'string') {
          first.push(data);
        }
      },
      close: () => {},
    });
    await room.attach('second', {
      send: (data) => {
        if (typeof data === 'string') {
          second.push(data);
        }
      },
      close: () => {},
    });
    await room.receive(
      'first',
      JSON.stringify({ type: 'start', commandId: 'start', generation: 0 }),
    );
    await handlers[0].onReady('one');
    const frame = (generation: number) => {
      const value = new ArrayBuffer(10);
      new DataView(value).setFloat64(0, generation);
      return value;
    };
    await room.receive('first', frame(1));
    expect(heard).toEqual([2]);
    now = 1001;
    await room.receive(
      'second',
      JSON.stringify({ type: 'takeover', commandId: 'take', generation: 1 }),
    );
    await handlers[1].onReady('two');
    await room.receive('first', frame(1));
    await room.receive('first', JSON.stringify({ type: 'pause', commandId: 'old', generation: 3 }));
    expect(first.map((data) => JSON.parse(data))).toContainEqual({
      type: 'error',
      commandId: 'old',
      code: 'NOT_OWNER',
    });
    await room.receive('second', frame(3));
    expect(heard).toEqual([2, 2]);
    const taking = room.receive(
      'first',
      JSON.stringify({ type: 'takeover', commandId: 'again', generation: 3 }),
    );
    const leaving = room.detach('second');
    await Promise.all([taking, leaving]);
    await handlers[2].onReady('three');
    await room.receive('first', frame(5));
    expect(heard).toEqual([2, 2, 2]);
    now = 2001;
    await room.receive(
      'first',
      JSON.stringify({ type: 'finish', commandId: 'end', generation: 5 }),
    );
    expect(first.map((data) => JSON.parse(data))).toContainEqual(
      expect.objectContaining({
        type: 'state',
        status: 'ended',
        evaluationJobId: '00000000-0000-4000-8000-000000000001',
      }),
    );
  } finally {
    database.close();
  }
});
