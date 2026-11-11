import { afterEach, expect, test, vi } from 'vitest';
import { interviews, deletedInterviews } from '@korekaite/database/interviews';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import worker, { InterviewObject } from '../src/worker.local.ts';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      protected ctx: object,
      protected env: object,
    ) {}
  },
}));

afterEach(() => vi.unstubAllGlobals());

class Socket extends EventTarget {
  send = vi.fn();
  close = vi.fn();
  accept = vi.fn();
}
function fixture() {
  const database = createTestDatabase();
  const setAlarm = vi.fn();
  const deleteAlarm = vi.fn();
  const data = new Map<string, { actorId: string; interviewId: string }>();
  const sockets: Socket[] = [];
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0 = new Socket();
      1 = new Socket();
      constructor() {
        sockets.push(this[1]);
      }
    },
  );
  const NativeResponse = Response;
  vi.stubGlobal(
    'Response',
    class extends NativeResponse {
      constructor(body: BodyInit | null, init: ResponseInit) {
        super(body, init.status === 101 ? {} : init);
        if (init.status === 101) {
          Object.defineProperty(this, 'status', { value: 101 });
        }
      }
    },
  );
  const pending: Promise<void>[] = [];
  const env = {
    DB: database.binding,
    APP_ENV: 'test',
    RESPONSES_MODEL: 'fixture',
    EVALUATION_MODEL: 'fixture',
    LIVE_VOICE: undefined as string | undefined,
    OPENAI_API_KEY: undefined as string | undefined,
    INTERVIEW_SESSION: { idFromName: (name: string) => name },
  };
  const ctx = {
    id: 'test:interview:interview',
    waitUntil: (work: Promise<void>) => pending.push(work),
    blockConcurrencyWhile: (work: () => Promise<void>) => work(),
    storage: {
      get: (key: string) => data.get(key),
      put: (key: string, value: { actorId: string; interviewId: string }) => data.set(key, value),
      deleteAll: () => data.clear(),
      deleteAlarm,
      setAlarm,
    },
  };
  const object = new InterviewObject(
    ctx as object as ConstructorParameters<typeof InterviewObject>[0],
    env as object as ConstructorParameters<typeof InterviewObject>[1],
  );
  const fetchObject = (
    method = 'GET',
    actor = 'actor',
    id = 'interview',
    upgrade = 'websocket',
  ) => {
    const headers = new Headers({ 'X-Interview-Actor': actor, 'X-Interview-ID': id });
    if (upgrade) {
      headers.set('Upgrade', upgrade);
    }
    return object.fetch(new Request('https://internal.invalid/', { method, headers }));
  };
  const seed = () =>
    database.db.insert(interviews).values({
      interviewId: 'interview',
      actorId: 'actor',
      materialHash: 'hash',
      themeTitle: '題',
      themeHeading: '判断',
      themeExcerpt: '架空',
      background: '',
      status: 'ready',
      createdAt: 0,
      updatedAt: 0,
    });
  return {
    database,
    object,
    env,
    data,
    sockets,
    fetchObject,
    seed,
    deleteAlarm,
    setAlarm,
    pending,
  };
}

test('内部ヘッダー・DO対応・Upgrade・削除マーカーを照合する', async () => {
  const f = fixture();
  try {
    expect((await worker.fetch()).status).toBe(404);
    for (const [actor, id] of [
      ['', 'interview'],
      ['a'.repeat(201), 'interview'],
      ['actor', ''],
      ['actor', '?'],
      ['actor', 'other'],
    ]) {
      expect((await f.fetchObject('GET', actor, id)).status).toBe(404);
    }
    expect((await f.fetchObject('POST')).status).toBe(426);
    expect((await f.fetchObject('GET', 'actor', 'interview', '')).status).toBe(426);
    expect((await f.fetchObject()).status).toBe(404);
    expect((await f.fetchObject('DELETE')).status).toBe(404);
    await f.object.alarm();
    await f.seed();
    for (const identity of [
      { actorId: 'other', interviewId: 'interview' },
      { actorId: 'actor', interviewId: 'other' },
    ]) {
      f.data.set('identity', identity);
      expect((await f.fetchObject()).status).toBe(503);
    }
    f.data.set('identity', { actorId: 'actor', interviewId: 'missing' });
    await expect(f.object.alarm()).rejects.toThrow('見つかりません');
    f.data.clear();
    f.env.LIVE_VOICE = 'invalid';
    expect((await f.fetchObject()).status).toBe(503);
    f.env.LIVE_VOICE = 'harema';
    f.env.RESPONSES_MODEL = '';
    expect((await f.fetchObject()).status).toBe(503);
    f.env.RESPONSES_MODEL = 'mock';
    Reflect.deleteProperty(f.env, 'EVALUATION_MODEL');
    expect((await f.fetchObject()).status).toBe(503);
  } finally {
    f.database.close();
  }
});

test('内部WebSocketを接続して操作と切断を配送し、削除で保存状態を解放する', async () => {
  const f = fixture();
  try {
    await f.seed();
    f.env.OPENAI_API_KEY = 'fixture';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    for (const _ of Array(4).keys()) {
      expect((await f.fetchObject()).status).toBe(101);
    }
    expect((await f.fetchObject()).status).toBe(503);
    expect(f.sockets[4].close).toHaveBeenCalledWith(1011);
    await f.object.alarm();
    const socket = f.sockets[0];
    socket.dispatchEvent(new MessageEvent('message', { data: {} }));
    socket.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(1) }));
    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'start', generation: 0, commandId: 'start' }),
      }),
    );
    await Promise.all(f.pending.splice(0));
    expect(f.setAlarm).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(socket.send.mock.calls.map(([s]) => JSON.parse(s))).toContainEqual(
        expect.objectContaining({ code: 'AUDIO_CONNECT_FAILED' }),
      ),
    );
    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'finish', generation: 2, commandId: 'end' }),
      }),
    );
    await Promise.all(f.pending.splice(0));
    expect(socket.send.mock.calls.map(([s]) => JSON.parse(s))).toContainEqual(
      expect.objectContaining({ status: 'ended' }),
    );
    socket.dispatchEvent(new Event('close'));
    f.sockets[1].dispatchEvent(new Event('error'));
    await Promise.all(f.pending.splice(0));
    await f.database.db
      .insert(deletedInterviews)
      .values({ interviewId: 'interview', actorId: 'actor', deletedAt: 1 });
    expect((await f.fetchObject('DELETE')).status).toBe(204);
    expect(f.data.size).toBe(0);
    expect(f.deleteAlarm).toHaveBeenCalled();
  } finally {
    f.database.close();
  }
});
