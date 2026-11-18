import { parseObject } from './helpers/json';
import { assert, expect, test, vi } from 'vitest';
import { createInterviewRoom } from '../src/application/interview-room';
import { AudioUsageLimitError } from '../src/application/interview-session';

type Settings = Parameters<typeof createInterviewRoom>[0];
type Hooks = Parameters<Settings['createSession']>[0];
type State = Parameters<NonNullable<Hooks['onState']>>[0];
function fixture(startsQuestion = false) {
  const row: State = {
    interviewId: 'i',
    actorId: 'actor',
    analysisId: null,
    themeIndex: null,
    materialHash: 'h',
    themeTitle: '題',
    themeHeading: '見出し',
    themeExcerpt: '抜粋',
    background: '',
    status: 'ready',
    generation: 1,
    streamGeneration: null,
    pendingQuestionOperation: null,
    activeMs: 0,
    activeSince: null,
    deadline: null,
    createdAt: 0,
    updatedAt: 0,
    endedAt: null,
    revision: 1,
    transcriptIncomplete: false,
  };
  const fragment = {
    interviewId: 'i',
    fragmentId: 'f',
    generation: 1,
    sequence: 1,
    startsQuestion,
    sourceEventId: 's',
    speaker: 'user' as const,
    content: '答え',
    sourceStartMs: null,
    sourceEndMs: null,
    receivedAt: 1,
  };
  const snapshot = async () => row;
  const session = {
    recover: snapshot,
    state: snapshot,
    start: vi.fn(snapshot),
    pause: vi.fn(snapshot),
    finish: vi.fn(async () => 'job'),
    tick: vi.fn(snapshot),
    disconnect: vi.fn(snapshot),
    discard: vi.fn(),
    playback: vi.fn(async () => true),
    request: vi.fn(async () => true),
    sendAudio: vi.fn(async () => true),
  };
  const createSession = vi.fn((_hooks: Hooks) => session);
  const room = createInterviewRoom({
    createSession,
    history: async () => [fragment],
    schedule: async () => {
      /* このテストでは呼出しに副作用を持たせない。 */
    },
  });
  const peer = { send: vi.fn<(data: string | ArrayBuffer) => void>(), close: vi.fn() };
  const events = () =>
    peer.send.mock.calls.flatMap(([data]) => (typeof data === 'string' ? [parseObject(data)] : []));
  const command = (type: string, id = type, generation = 1) =>
    room.receive(
      'peer',
      JSON.stringify({
        type,
        commandId: id,
        generation,
        ...(type === 'playback' ? { audioOffsetMs: 1 } : {}),
      }),
    );
  return {
    room,
    hooks: (createSession.mock.lastCall ?? assert.fail('必須のテスト値がありません。'))[0],
    session,
    row,
    peer,
    events,
    command,
    fragment,
  };
}

test('操作IDの再送・衝突・期限切れと状態に合わない操作を処理する', async () => {
  const { room, row, session, peer, events, command } = fixture();
  await room.attach('peer', peer);
  expect(events()).toContainEqual(expect.objectContaining({ type: 'transcript', fragmentId: 'f' }));
  await command('sync', 'same');
  await command('sync', 'same');
  await command('start', 'same');
  expect(events().at(-1)).toMatchObject({ code: 'INVALID_EVENT' });
  for (const n of Array.from({ length: 101 }).keys()) {
    await command('sync', `sync-${n}`);
  }
  await command('start', 'same');
  expect(session.start).toHaveBeenCalledOnce();
  await command('pause', 'old', 0);
  expect(events().at(-2)).toMatchObject({ code: 'STALE_STATE' });
  await command('resume');
  expect(events().at(-1)).toMatchObject({ code: 'STALE_STATE' });
  row.status = 'paused';
  await command('start');
  expect(events().at(-1)).toMatchObject({ code: 'STALE_STATE' });
  await command('resume');
  row.status = 'active';
  for (const type of ['rephrase', 'skip', 'pause', 'playback']) {
    await command(type);
    expect(events().at(-1)).toMatchObject({ type: 'ack' });
  }
  session.playback.mockResolvedValueOnce(false);
  await command('playback', 'late');
  expect(events().at(-1)).toMatchObject({ code: 'INVALID_EVENT' });
  session.request.mockResolvedValueOnce(false);
  await command('skip', 'late-skip');
  expect(events().at(-1)).toMatchObject({ code: 'STALE_STATE' });
  row.status = 'ended';
  await command('takeover');
  expect(events().at(-1)).toMatchObject({ code: 'STALE_STATE' });
});

test('受信フレームと接続の制限を検証し、例外を利用者向けエラーへ変換する', async () => {
  const { room, session, peer, events, command } = fixture();
  await room.attach('peer', peer);
  for (const data of [
    '[',
    '{}',
    'x'.repeat(8193),
    new ArrayBuffer(1),
    new ArrayBuffer(11),
    new ArrayBuffer(9610),
  ]) {
    await room.receive('peer', data);
    expect(events().at(-1)).toMatchObject({ code: 'INVALID_EVENT' });
  }
  for (const [id, err, code] of [
    ['limit', new AudioUsageLimitError(), 'AUDIO_USAGE_LIMIT'],
    ['down', new Error('上流切断'), 'UNAVAILABLE'],
  ] as const) {
    session.start.mockRejectedValueOnce(err);
    await command('start', id);
    expect(events().at(-1)).toMatchObject({ code });
  }
  await command('start');
  for (const gen of [0, Number.NaN]) {
    const data = new ArrayBuffer(10);
    new DataView(data).setFloat64(0, gen);
    await room.receive('peer', data);
    expect(events().at(-1)).toMatchObject({ code: 'NOT_OWNER' });
  }
  await Promise.all(Array.from({ length: 65 }, () => room.receive('peer', '{}')));
  expect(peer.close).toHaveBeenCalledTimes(1);
  const count = events().length;
  await room.receive('peer', '{}');
  expect(events()).toHaveLength(count);
});

test('出力音声は操作中の世代へ配信し、送信に失敗した端末を切断する', async () => {
  const { room, hooks, row, peer, events, command, fragment, session } = fixture();
  hooks.onDialFailure?.();
  hooks.onAudio?.(1, new Uint8Array(2), 1);
  await room.attach('peer', peer);
  await command('start');
  hooks.onAudio?.(1, new Uint8Array(2), 1);
  row.status = 'active';
  await hooks.onState?.(row, null);
  hooks.onAudio?.(2, new Uint8Array(2), 1);
  expect(events().some((e) => e.type === 'audio')).toBe(false);
  hooks.onTranscript?.(fragment);
  hooks.onAudio?.(1, new Uint8Array(2), 1);
  expect(peer.send).toHaveBeenLastCalledWith(new ArrayBuffer(2));
  peer.send.mockImplementation((data) => {
    if (typeof data !== 'string') {
      throw new TypeError('切断');
    }
  });
  hooks.onAudio?.(1, new Uint8Array(2), 1);
  await room.alarm();
  expect(session.disconnect).toHaveBeenCalledOnce();
  await room.attach('peer', peer);
  peer.send.mockImplementationOnce(() => {
    throw new TypeError('切断');
  });
  hooks.onTranscript?.(fragment);
  await room.alarm();
  expect(peer.close).toHaveBeenCalledTimes(2);
  await room.attach('peer', peer);
  expect(() => hooks.onTranscript?.({ ...fragment, sequence: 0 })).toThrow('生成');
  room.discard('i');
  await hooks.onState?.(row, null);
  await expect(room.attach('new', peer)).rejects.toThrow('接続数');
});

test('エラー送信時に削除された面接の状態を再配信しない', async () => {
  const { room, peer, command, events } = fixture();
  await room.attach('peer', peer);
  peer.send.mockImplementationOnce(() => {
    room.discard('i');
  });
  await command('pause', 'old', 0);
  expect(events().at(-1)).toMatchObject({ type: 'deleted' });
});

test('保存済みの質問境界を新しい画面に再配信し、旧画面には従来の形式を返す', async () => {
  const { room, peer, events } = fixture(true);
  await room.attach('old', peer);
  expect(events().find((event) => event.type === 'transcript')).not.toHaveProperty(
    'startsQuestion',
  );
  peer.send.mockClear();
  await room.attach('new', { ...peer, questionBoundaries: true });
  expect(events().find((event) => event.type === 'transcript')).toMatchObject({
    startsQuestion: true,
  });
});

test('音声送信中にD1が再接続待ちになったら、担当タブへ現在の世代を通知する', async () => {
  const { room, peer, session, row, events, command } = fixture();
  await room.attach('peer', peer);
  await command('start');
  session.sendAudio.mockResolvedValue(false);
  session.state = async () => ({ ...row, status: 'reconnecting', generation: 2 });
  const frame = new ArrayBuffer(10);
  new DataView(frame).setFloat64(0, 1);
  await room.receive('peer', frame);
  expect(events().at(-1)).toMatchObject({ type: 'state', status: 'reconnecting', generation: 2 });
  session.state = async () => ({ ...row, status: 'active', generation: 1 });
  await room.receive('peer', frame);
  expect(events().at(-1)).toMatchObject({ type: 'error', code: 'UNAVAILABLE' });
});

test('質問操作IDの再送で二重接続せず、切替中にタブを閉じた場合は自動開始しない', async () => {
  const { room, peer, session, row, command } = fixture();
  await room.attach('peer', peer);
  await command('start');
  row.status = 'active';
  await command('skip', 'skip');
  await command('skip', 'skip');
  expect(session.request).toHaveBeenCalledOnce();
  expect(session.start).toHaveBeenCalledTimes(2);
  const submission: { settle: (accepted: boolean) => void } = {
    settle: () => assert.fail('要求の開始後にのみ確定できます。'),
  };
  session.request.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        submission.settle = resolve;
      }),
  );
  const changing = command('rephrase', 'next');
  await vi.waitFor(() => {
    expect(session.request).toHaveBeenCalledTimes(2);
  });
  const left = room.detach('peer');
  submission.settle(true);
  await Promise.all([changing, left]);
  expect(session.start).toHaveBeenCalledTimes(2);
});

test('入力の滞留による切断は内容を含めず理由だけを記録する', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  try {
    const { room, peer } = fixture();
    await room.attach('peer', peer);
    await Promise.all(Array.from({ length: 65 }, () => room.receive('peer', '{}')));
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('interview_input_backpressure');
  } finally {
    info.mockRestore();
  }
});

function audioFrame(value: number, size = 2, generation = 1) {
  const frame = new ArrayBuffer(8 + size);
  new DataView(frame).setFloat64(0, generation);
  new Uint8Array(frame, 8).fill(value);
  return frame;
}

test('処理待ちの連続音声を世代と順序を保ってまとめる', async () => {
  const { room, peer, command, session } = fixture();
  await room.attach('peer', peer);
  await command('start');
  const held = Promise.withResolvers<boolean>();
  session.sendAudio.mockImplementationOnce(() => held.promise);
  const first = room.receive('peer', audioFrame(1));
  await vi.waitFor(() => expect(session.sendAudio).toHaveBeenCalledTimes(1));
  const second = room.receive('peer', audioFrame(2));
  const third = room.receive('peer', audioFrame(3));
  held.resolve(true);
  await Promise.all([first, second, third]);
  expect(session.sendAudio.mock.calls).toEqual([
    [1, Uint8Array.from([1, 1])],
    [1, Uint8Array.from([2, 2, 3, 3])],
  ]);
});

test('音声の集約は操作・接続・世代の境界を越えない', async () => {
  const { room, peer, command, session } = fixture();
  await room.attach('peer', peer);
  await room.attach('observer', {
    send: vi.fn<(data: string | ArrayBuffer) => void>(),
    close: vi.fn<() => void>(),
  });
  await command('start');
  const held = Promise.withResolvers<boolean>();
  session.sendAudio.mockImplementationOnce(() => held.promise);
  const first = room.receive('peer', audioFrame(1));
  await vi.waitFor(() => expect(session.sendAudio).toHaveBeenCalledTimes(1));
  const pending = [
    room.receive('peer', audioFrame(2)),
    command('playback'),
    room.receive('peer', audioFrame(3)),
    room.receive('observer', audioFrame(9)),
    room.receive('peer', audioFrame(4)),
    room.receive('peer', new ArrayBuffer(9610)),
    room.receive('peer', audioFrame(7)),
    room.receive('peer', audioFrame(5, 2, 2)),
    room.receive('peer', audioFrame(6)),
  ];
  held.resolve(true);
  await Promise.all([first, ...pending]);
  expect(session.sendAudio.mock.calls).toEqual([
    [1, Uint8Array.from([1, 1])],
    [1, Uint8Array.from([2, 2])],
    [1, Uint8Array.from([3, 3])],
    [1, Uint8Array.from([4, 4])],
    [1, Uint8Array.from([7, 7])],
    [2, Uint8Array.from([5, 5])],
    [1, Uint8Array.from([6, 6])],
  ]);
  expect(session.sendAudio.mock.invocationCallOrder[1]).toBeLessThan(
    session.playback.mock.invocationCallOrder[0],
  );
  expect(session.playback.mock.invocationCallOrder[0]).toBeLessThan(
    session.sendAudio.mock.invocationCallOrder[2],
  );
});

test('集約後の音声も9600バイトを超えない', async () => {
  const { room, peer, command, session } = fixture();
  await room.attach('peer', peer);
  await command('start');
  const held = Promise.withResolvers<boolean>();
  session.sendAudio.mockImplementationOnce(() => held.promise);
  const first = room.receive('peer', audioFrame(1));
  await vi.waitFor(() => expect(session.sendAudio).toHaveBeenCalledTimes(1));
  const pending = Array.from({ length: 5 }, (_, index) =>
    room.receive('peer', audioFrame(index + 2, 2400)),
  );
  held.resolve(true);
  await Promise.all([first, ...pending]);
  expect(session.sendAudio.mock.calls).toEqual([
    [1, new Uint8Array(2).fill(1)],
    [
      1,
      Uint8Array.from([2, 3, 4, 5].flatMap((value) => Array.from({ length: 2400 }, () => value))),
    ],
    [1, new Uint8Array(2400).fill(6)],
  ]);
});

test('音声を集約しても元の入力64件の上限で切断する', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  try {
    const { room, peer, command, session } = fixture();
    await room.attach('peer', peer);
    await command('start');
    const held = Promise.withResolvers<boolean>();
    session.sendAudio.mockImplementationOnce(() => held.promise);
    const first = room.receive('peer', audioFrame(1));
    await vi.waitFor(() => expect(session.sendAudio).toHaveBeenCalledTimes(1));
    const pending = Array.from({ length: 63 }, () => room.receive('peer', audioFrame(2)));
    expect(peer.close).not.toHaveBeenCalled();
    const overflow = room.receive('peer', audioFrame(3));
    expect(peer.close).toHaveBeenCalledOnce();
    held.resolve(true);
    await Promise.all([first, ...pending, overflow]);
    expect(session.sendAudio).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
  }
});

test('アラームを挟んだ音声は期限確認より前に集約しない', async () => {
  const { room, peer, command, session } = fixture();
  await room.attach('peer', peer);
  await command('start');
  const held = Promise.withResolvers<boolean>();
  session.sendAudio.mockImplementationOnce(() => held.promise);
  const first = room.receive('peer', audioFrame(1));
  await vi.waitFor(() => expect(session.sendAudio).toHaveBeenCalledTimes(1));
  const second = room.receive('peer', audioFrame(2));
  const alarm = room.alarm();
  const third = room.receive('peer', audioFrame(3));
  held.resolve(true);
  await Promise.all([first, second, alarm, third]);
  expect(session.sendAudio).toHaveBeenCalledTimes(3);
  expect(session.sendAudio.mock.invocationCallOrder[1]).toBeLessThan(
    session.tick.mock.invocationCallOrder[0],
  );
  expect(session.tick.mock.invocationCallOrder[0]).toBeLessThan(
    session.sendAudio.mock.invocationCallOrder[2],
  );
});

test('20ms入力より遅い30ms処理でも滞留を解消して接続を保つ', async () => {
  vi.useFakeTimers();
  try {
    const { room, peer, command, session } = fixture();
    await room.attach('peer', peer);
    await command('start');
    session.sendAudio.mockImplementation(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 30);
      });
      return true;
    });
    const pending = [];
    for (const index of Array.from({ length: 250 }).keys()) {
      pending.push(room.receive('peer', audioFrame(index % 256, 960)));
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(peer.close).not.toHaveBeenCalled();
    expect(session.sendAudio.mock.calls.length).toBeLessThan(250);
  } finally {
    vi.useRealTimers();
  }
});
