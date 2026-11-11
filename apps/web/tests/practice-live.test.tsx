// @vitest-environment jsdom
import './helpers/dom';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { PracticeLive } from '../src/components/practice-live';
import { sessionToken } from '../src/lib/practice';
vi.mock('../src/lib/practice', () => ({ sessionToken: vi.fn().mockResolvedValue('token') }));
import { openInterviewAudio } from '../src/lib/practice-audio';
vi.mock('../src/lib/practice-audio', async (original) => ({
  ...(await original<typeof import('../src/lib/practice-audio')>()),
  openInterviewAudio: vi.fn(),
}));

test('開始操作でマイクを準備し、面接中だけ音声を送り、一時停止で解放する', async () => {
  const user = userEvent.setup();
  const send = vi.fn();
  const peers: FakeSocket[] = [];
  class FakeSocket {
    readyState = 1;
    bufferedAmount = 0;
    send = send;
    close = vi.fn();
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() {
      peers.push(this);
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  const close = vi.fn();
  let capture!: (bytes: ArrayBuffer) => void;
  vi.mocked(openInterviewAudio).mockImplementation(async (_signal, captured) => {
    capture = captured;
    return { play: vi.fn(), stopPlayback: vi.fn(), close };
  });
  const done = vi.fn();
  render(<PracticeLive id="one" onEnded={done} />);
  const state = (status: string, generation: number, canControl: boolean) =>
    act(() =>
      peers[0].onmessage!(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'state',
            interviewId: 'one',
            status,
            generation,
            canControl,
            activeMs: 0,
            activeSince: null,
            deadline: null,
            updatedAt: 1,
            transcriptIncomplete: false,
            evaluationJobId: null,
          }),
        }),
      ),
    );
  state('ready', 0, false);
  expect(openInterviewAudio).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'マイクを許可して開始' }));
  expect(JSON.parse(send.mock.lastCall![0])).toMatchObject({ type: 'start', generation: 0 });
  capture(new ArrayBuffer(2));
  expect(send).toHaveBeenCalledTimes(1);
  state('active', 1, true);
  capture(new ArrayBuffer(2));
  expect(new DataView(send.mock.lastCall![0]).getFloat64(0)).toBe(1);
  await user.click(screen.getByRole('button', { name: '一時停止' }));
  expect(close).toHaveBeenCalled();
  expect(JSON.parse(send.mock.lastCall![0])).toMatchObject({ type: 'pause', generation: 1 });
  state('paused', 2, true);
  await user.click(screen.getByRole('button', { name: 'マイクを許可して再開' }));
  close.mockClear();
  // 終了確認が遅れた旧接続から、同じ世代の一時停止状態が再通知される。
  state('paused', 2, true);
  expect(close).not.toHaveBeenCalled();
  state('active', 3, true);
  capture(new ArrayBuffer(2));
  expect(new DataView(send.mock.lastCall![0]).getFloat64(0)).toBe(3);
  state('ended', 4, false);
  expect(done).toHaveBeenCalledTimes(1);
});

test('切断後に同じ面接へ自動接続し、失敗が続いたら1分で止まる', async () => {
  vi.useFakeTimers();
  try {
    const peers: Peer[] = [];
    class Peer {
      onclose: (() => void) | null = null;
      close = vi.fn();
      constructor(readonly url: URL) {
        peers.push(this);
      }
    }
    vi.stubGlobal('WebSocket', Peer);
    render(<PracticeLive id="same" onEnded={() => {}} />);
    act(() => peers[0].onclose!());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(peers).toHaveLength(2);
    expect(peers[1].url.pathname).toBe('/api/interviews/same/live');
    act(() => peers[1].onclose!());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(peers).toHaveLength(3);
    // 最後の接続が期限直前まで応答しなかった場合、次の試行は期限を超える。
    vi.spyOn(performance, 'now').mockReturnValue(59_999);
    act(() => peers[2].onclose!());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(peers).toHaveLength(3);
  } finally {
    vi.useRealTimers();
  }
});

test.each([true, false, 'manual'] as const)(
  '復帰時に切断直前の音声担当タブだけが同じ面接を再開する（担当=%s）',
  async (owner) => {
    vi.useFakeTimers();
    try {
      const peers: Peer[] = [];
      class Peer {
        readyState = 1;
        bufferedAmount = 0;
        onclose: (() => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        close = vi.fn();
        send = vi.fn();
        constructor() {
          peers.push(this);
        }
      }
      vi.stubGlobal('WebSocket', Peer);
      const stop = vi.fn();
      vi.mocked(openInterviewAudio)
        .mockClear()
        .mockResolvedValue({ play: vi.fn(), stopPlayback: vi.fn(), close: stop });
      render(<PracticeLive id="same" onEnded={() => {}} />);
      const receive = async (status: string, generation: number, canControl: boolean) => {
        await act(async () =>
          peers.at(-1)?.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'state',
                interviewId: 'same',
                status,
                generation,
                canControl,
                activeSince: null,
                activeMs: 0,
                deadline: null,
                updatedAt: 0,
                transcriptIncomplete: false,
                evaluationJobId: null,
              }),
            }),
          ),
        );
      };
      await receive('ready', 0, false);
      if (owner) {
        await act(async () => {
          screen.getByRole('button', { name: 'マイクを許可して開始' }).click();
        });
      }
      await receive('active', 1, Boolean(owner));
      act(() => peers[0].onclose!());
      if (owner) {
        expect(stop).toHaveBeenCalled();
      }
      vi.mocked(sessionToken).mockClear();
      if (owner === 'manual') {
        await act(async () => screen.getByRole('button', { name: '再接続' }).click());
      } else {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      expect(sessionToken).toHaveBeenCalledTimes(1);
      await receive('reconnecting', 2, false);
      if (owner) {
        expect(JSON.parse(peers[1].send.mock.lastCall![0])).toMatchObject({
          type: 'resume',
          generation: 2,
        });
        expect(openInterviewAudio).toHaveBeenCalledTimes(2);
      } else {
        expect(peers[1].send).not.toHaveBeenCalled();
        expect(openInterviewAudio).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

test('マイクを拒否した場合は開始せず、許可待ちで画面を閉じた場合は後から届いた入力を解放する', async () => {
  const user = userEvent.setup();
  const peers: Peer[] = [];
  class Peer {
    readyState = 1;
    bufferedAmount = 0;
    onmessage: ((event: MessageEvent) => void) | null = null;
    close = vi.fn();
    send = vi.fn();
    constructor() {
      peers.push(this);
    }
  }
  vi.stubGlobal('WebSocket', Peer);
  const ready = () =>
    act(() =>
      peers[0].onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'state',
            interviewId: 'mic',
            status: 'ready',
            generation: 0,
            canControl: false,
            activeSince: null,
            activeMs: 0,
            deadline: null,
            updatedAt: 0,
            transcriptIncomplete: false,
            evaluationJobId: null,
          }),
        }),
      ),
    );
  let allow!: (audio: Awaited<ReturnType<typeof openInterviewAudio>>) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(openInterviewAudio)
    .mockRejectedValueOnce(new DOMException('拒否', 'NotAllowedError'))
    .mockImplementationOnce((request) => {
      signal = request;
      return new Promise((resolve) => {
        allow = resolve;
      });
    });
  const page = render(<PracticeLive id="mic" onEnded={() => {}} />);
  ready();
  await user.click(screen.getByRole('button', { name: 'マイクを許可して開始' }));
  expect(screen.getByRole('alert').textContent).toMatch(/使用許可/);
  expect(peers[0].send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'マイクを許可して開始' }));
  page.unmount();
  expect(signal?.aborted).toBe(true);
  const close = vi.fn();
  await act(async () => allow({ play: vi.fn(), stopPlayback: vi.fn(), close }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(peers[0].send).not.toHaveBeenCalled();
});

function mountLive() {
  const peers: Peer[] = [];
  class Peer {
    readyState = 1;
    bufferedAmount = 0;
    close = vi.fn();
    send = vi.fn();
    onmessage!: (event: MessageEvent) => void;
    onerror!: () => void;
    onclose!: () => void;
    constructor() {
      peers.push(this);
    }
  }
  vi.stubGlobal('WebSocket', Peer);
  const audio = { play: vi.fn(), close: vi.fn(), stopPlayback: vi.fn() };
  vi.mocked(openInterviewAudio).mockReset().mockResolvedValue(audio);
  const deleted = vi.fn();
  const page = render(<PracticeLive id="live" onEnded={vi.fn()} onDeleted={deleted} />);
  const peer = peers[0];
  const raw = (data: string | ArrayBuffer | Blob) =>
    act(() => peer.onmessage(new MessageEvent('message', { data })));
  const receive = (event: object) => raw(JSON.stringify(event));
  const state = (extra: object = {}) =>
    receive({
      type: 'state',
      interviewId: 'live',
      generation: 1,
      status: 'active',
      canControl: true,
      activeSince: null,
      activeMs: 0,
      deadline: null,
      updatedAt: 1,
      transcriptIncomplete: false,
      evaluationJobId: null,
      ...extra,
    });
  const click = (name: string) => act(async () => screen.getByRole('button', { name }).click());
  return { peers, peer, audio, page, deleted, raw, receive, state, click };
}

test('通話中の引き継ぎは旧接続の再開待ちを経ても、新担当のマイクを維持する', async () => {
  const { state, click, audio, peer } = mountLive();
  state({ canControl: false });
  await click('このタブで引き継ぐ');
  const [, capture] = vi.mocked(openInterviewAudio).mock.lastCall!;
  state({ status: 'reconnecting', generation: 2, canControl: false });
  capture(new ArrayBuffer(2));
  expect(peer.send).toHaveBeenCalledTimes(1);
  state({ status: 'connecting', generation: 3 });
  state({ status: 'active', generation: 3 });
  expect(audio.close).not.toHaveBeenCalled();
  capture(new ArrayBuffer(2));
  expect(new DataView(peer.send.mock.lastCall![0]).getFloat64(0)).toBe(3);
});

test('非担当タブで一時停止中に選べる音声操作は引き継ぎだけ', async () => {
  const { state, click, peer } = mountLive();
  state({ status: 'paused', canControl: false });
  expect(screen.queryByRole('button', { name: 'マイクを許可して再開' })).toBeNull();
  await click('このタブで引き継ぐ');
  expect(JSON.parse(peer.send.mock.lastCall![0]).type).toBe('takeover');
});

test('質問と発言を順番にまとめ、言い換え・スキップ・終了を送る', async () => {
  vi.useFakeTimers();
  const { receive, state, click, peer } = mountLive();
  state({ activeSince: 1, activeMs: 900000 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(screen.getByText(/15分が経過/)).toBeTruthy();
  state({ activeSince: 1, deadline: 5 });
  for (const [sequence, speaker, content, generation] of [
    [2, 'assistant', 'ですか', 1],
    [1, 'assistant', 'なぜ', 1],
    [3, 'user', '回答', 1],
    [4, 'user', '補足', 2],
  ] as const) {
    receive({
      type: 'transcript',
      fragmentId: 'id' + sequence,
      sequence,
      generation,
      speaker,
      content,
      sourceStartMs: null,
      sourceEndMs: null,
    });
  }
  expect(screen.getByText('現在の質問').nextElementSibling?.textContent).toBe('なぜですか');
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  await click('言い換えを依頼');
  const rephrase = JSON.parse(peer.send.mock.lastCall![0]);
  expect(rephrase).toMatchObject({ type: 'rephrase', generation: 1 });
  await click('質問を見送る');
  expect(JSON.parse(peer.send.mock.lastCall![0]).type).toBe('rephrase');
  receive({ type: 'error', commandId: rephrase.commandId, code: 'STALE_STATE' });
  await click('質問を見送る');
  expect(JSON.parse(peer.send.mock.lastCall![0])).toMatchObject({ type: 'skip', generation: 1 });
  await click('終了して評価する');
  state({ generation: 2, status: 'reconnecting' });
  state({ generation: 3, status: 'connecting' });
  expect(JSON.parse(peer.send.mock.lastCall![0])).toMatchObject({ type: 'finish', generation: 3 });
  receive({ type: 'ack', commandId: 'ack' });
  expect(screen.queryByRole('alert')).toBeNull();
});

const audioHeader = { type: 'audio', generation: 1, endOffsetMs: 20, byteLength: 2 };
test('質問の切替前の音声を止め、新世代の質問の文字と再生完了までマイク送信を止める', async () => {
  const { state, click, audio, peer, receive, raw } = mountLive();
  state({ status: 'ready' });
  await click('マイクを許可して開始');
  state();
  const [, capture] = vi.mocked(openInterviewAudio).mock.lastCall!;
  await click('言い換えを依頼');
  expect(audio.stopPlayback).toHaveBeenCalledOnce();
  peer.send.mockClear();
  capture(new ArrayBuffer(2));
  receive(audioHeader);
  raw(new ArrayBuffer(2));
  expect(audio.play).not.toHaveBeenCalled();
  state({ status: 'reconnecting', generation: 2 });
  expect(audio.close).not.toHaveBeenCalled();
  state({ status: 'connecting', generation: 3 });
  state({ generation: 3 });
  capture(new ArrayBuffer(2));
  expect(peer.send).not.toHaveBeenCalled();
  const question = new Int16Array(6000).fill(512).buffer;
  receive({ ...audioHeader, generation: 3, byteLength: question.byteLength });
  raw(question);
  act(() => audio.play.mock.lastCall![1]());
  peer.send.mockClear();
  capture(new ArrayBuffer(2));
  expect(peer.send).not.toHaveBeenCalled();
  receive({
    type: 'transcript',
    speaker: 'assistant',
    generation: 3,
    sequence: 1,
    fragmentId: 'q3',
    content: '次の質問',
    sourceStartMs: null,
    sourceEndMs: null,
  });
  capture(new ArrayBuffer(2));
  expect(new DataView(peer.send.mock.lastCall![0]).getFloat64(0)).toBe(3);
});

test('質問切替中の一時停止はすぐマイクを解放し、新世代の面接中に一度だけ停止を送る', async () => {
  const { state, click, audio, peer } = mountLive();
  state({ status: 'ready' });
  await click('マイクを許可して開始');
  state();
  await click('質問を見送る');
  await click('一時停止');
  expect(audio.close).toHaveBeenCalledOnce();
  peer.send.mockClear();
  state({ status: 'reconnecting', generation: 2 });
  state({ status: 'connecting', generation: 3 });
  expect(peer.send).not.toHaveBeenCalled();
  state({ generation: 3 });
  state({ generation: 3 });
  expect(peer.send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(peer.send.mock.lastCall![0])).toMatchObject({ type: 'pause', generation: 3 });
});

test('質問切替中に一時停止を押して新接続に失敗しても、再開待ちの世代を一時停止する', async () => {
  const { state, click, audio, peer, receive } = mountLive();
  state({ status: 'ready' });
  await click('マイクを許可して開始');
  state();
  await click('質問を見送る');
  state({ status: 'reconnecting', generation: 2 });
  await click('一時停止');
  expect(audio.close).toHaveBeenCalledOnce();
  peer.send.mockClear();
  state({ status: 'connecting', generation: 3 });
  receive({ type: 'error', commandId: null, code: 'AUDIO_CONNECT_FAILED' });
  state({ status: 'reconnecting', generation: 4 });
  state({ status: 'reconnecting', generation: 4 });
  expect(peer.send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(peer.send.mock.lastCall![0])).toMatchObject({ type: 'pause', generation: 4 });
  state({ status: 'paused', generation: 5 });
  expect(screen.getByRole('button', { name: 'マイクを許可して再開' })).toBeTruthy();
  expect(audio.close).toHaveBeenCalledOnce();
});

test('新世代で言い換えの返答が届く前でも質問を見送れる', async () => {
  const { state, click, peer } = mountLive();
  state();
  await click('言い換えを依頼');
  state({ status: 'reconnecting', generation: 2 });
  state({ status: 'connecting', generation: 3 });
  state({ generation: 3 });
  await click('質問を見送る');
  expect(JSON.parse(peer.send.mock.lastCall![0])).toMatchObject({ type: 'skip', generation: 3 });
});

test('切替先で音声だけが届いても、20秒後に文字待ちと復帰操作を表示する', async () => {
  vi.useFakeTimers();
  const { state, click, audio, receive, raw, peer } = mountLive();
  state({ status: 'ready' });
  await click('マイクを許可して開始');
  state();
  await click('言い換えを依頼');
  state({ status: 'reconnecting', generation: 2 });
  state({ status: 'connecting', generation: 3 });
  state({ generation: 3 });
  const question = new Int16Array(6000).fill(512).buffer;
  receive({ ...audioHeader, generation: 3, byteLength: question.byteLength });
  raw(question);
  act(() => audio.play.mock.lastCall![1]());
  await act(async () => vi.advanceTimersByTimeAsync(20500));
  expect(screen.getByText(/質問の文字がまだ届いていません/)).toBeTruthy();
  await click('音声をつなぎ直す');
  expect(JSON.parse(peer.send.mock.lastCall![0])).toMatchObject({ type: 'pause', generation: 3 });
});
test('担当タブで再生した音声だけを受領し、再生中の世代や担当変更を検知する', async () => {
  const { peer, audio, receive, state, raw, click } = mountLive();
  state({ canControl: false });
  await click('このタブで引き継ぐ');
  expect(JSON.parse(peer.send.mock.lastCall![0]).type).toBe('takeover');
  state();
  function frame(generation: number) {
    receive({ ...audioHeader, generation });
    raw(new ArrayBuffer(2));
  }
  frame(2);
  expect(audio.play).not.toHaveBeenCalled();
  frame(1);
  const complete = audio.play.mock.lastCall![1];
  complete();
  expect(JSON.parse(peer.send.mock.lastCall![0])).toMatchObject({
    type: 'playback',
    audioOffsetMs: 20,
  });
  peer.send.mockClear();
  peer.readyState = 3;
  complete();
  await click('言い換えを依頼');
  peer.readyState = 1;
  state({ generation: 2 });
  complete();
  state({ canControl: false });
  complete();
  frame(1);
  state({ status: 'paused' });
  frame(1);
  expect(audio.play).toHaveBeenCalledTimes(1);
  expect(peer.send).not.toHaveBeenCalled();
});

test.each([
  'ヘッダーなし',
  '別形式',
  '長さ違い',
  'ヘッダー重複',
  '不明イベント',
  '別の面接',
  '別の削除',
])('不正なイベント（%s）では再接続を促す', (kind) => {
  const { peer, raw, receive, state } = mountLive();
  switch (kind) {
    case 'ヘッダーなし':
      raw(new ArrayBuffer(2));
      break;
    case '別形式':
      receive(audioHeader);
      raw(new Blob());
      break;
    case '長さ違い':
      receive(audioHeader);
      raw(new ArrayBuffer(4));
      break;
    case 'ヘッダー重複':
      receive(audioHeader);
      receive(audioHeader);
      break;
    case '不明イベント':
      receive({ type: 'unknown' });
      break;
    case '別の面接':
      state({ interviewId: 'other' });
      break;
    default:
      receive({ type: 'deleted', interviewId: 'other' });
  }
  expect(peer.close).toHaveBeenCalledOnce();
  expect(screen.getByRole('alert').textContent).toMatch(/再開/);
});

test('削除通知を受けて再接続を止める', async () => {
  vi.useFakeTimers();
  const { deleted, receive, peer, peers } = mountLive();
  receive({ type: 'deleted', interviewId: 'live' });
  act(() => peer.onclose());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(deleted).toHaveBeenCalledOnce();
  expect(peers).toHaveLength(1);
});

test.each(['AUDIO_CONNECT_FAILED', 'AUDIO_USAGE_LIMIT', 'INVALID_EVENT', 'NOT_OWNER'])(
  'サーバーのエラー %s と担当状態に応じてマイクを解放する',
  async (code) => {
    const { audio, receive, state, click } = mountLive();
    state({ status: 'reconnecting', canControl: false });
    await click('マイクを許可して再開');
    if (code !== 'NOT_OWNER') {
      state();
    }
    receive({ type: 'error', commandId: null, code });
    expect(screen.getByRole('alert').textContent).not.toBe('');
    expect(audio.close).toHaveBeenCalledTimes(code === 'INVALID_EVENT' ? 0 : 1);
  },
);

test.each(['切断', '送信遅延'])('マイクの%sで送信を停止する', async (kind) => {
  const { audio, peer, state, click } = mountLive();
  state({ status: 'ready' });
  await click('マイクを許可して開始');
  state();
  const [, capture, lost] = vi.mocked(openInterviewAudio).mock.lastCall!;
  if (kind === '切断') {
    act(lost);
    expect(JSON.parse(peer.send.mock.lastCall![0]).type).toBe('pause');
  } else {
    peer.bufferedAmount = 300000;
    act(() => capture(new ArrayBuffer(2)));
    expect(peer.close).toHaveBeenCalledOnce();
  }
  expect(audio.close).toHaveBeenCalledOnce();
  expect(screen.getByRole('alert').textContent).toMatch(/マイクが切断|送信が追いつかず/);
  const count = peer.send.mock.calls.length;
  capture(new ArrayBuffer(2));
  expect(peer.send).toHaveBeenCalledTimes(count);
});

test.each(['世代変更', 'ソケット終了', 'ユーザー中断'])(
  'マイクの準備完了までの%sを処理する',
  async (kind) => {
    const { audio, peer, state, click, page } = mountLive();
    let allow!: (value: typeof audio) => void;
    let deny!: () => void;
    vi.mocked(openInterviewAudio).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          allow = resolve;
          deny = reject;
        }),
    );
    state({ status: 'ready' });
    await click('マイクを許可して開始');
    if (kind === 'ユーザー中断') {
      page.unmount();
      await act(async () => deny());
    } else {
      if (kind === '世代変更') {
        state({ generation: 2 });
      } else {
        peer.readyState = 3;
      }
      await act(async () => allow(audio));
      expect(audio.close).toHaveBeenCalledOnce();
    }
    expect(peer.send).not.toHaveBeenCalled();
  },
);

test('応答待ちを打ち切り、セッション再取得失敗を表示する', async () => {
  vi.useFakeTimers();
  const { peer } = mountLive();
  act(() => peer.onerror());
  expect(screen.getByRole('alert').textContent).toMatch(/接続が切れ/);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(peer.close).toHaveBeenCalledOnce();
  vi.mocked(sessionToken).mockRejectedValueOnce(new Error('unreachable'));
  act(() => peer.onclose());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByRole('alert').textContent).toMatch(/起動時のURL/);
});

test('開始を送った直後の再クリックでマイクを重複取得しない', async () => {
  const { state, click } = mountLive();
  state({ status: 'ready' });
  await click('マイクを許可して開始');
  await click('マイクを許可して開始');
  expect(openInterviewAudio).toHaveBeenCalledOnce();
});

test('復帰期限を過ぎて実行されたタイマーでは接続しない', async () => {
  vi.useFakeTimers();
  const { peers, peer } = mountLive();
  act(() => peer.onclose());
  vi.spyOn(performance, 'now').mockReturnValue(70000);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(peers).toHaveLength(1);
});

test.each([true, false])('再認証待ちに画面を閉じたら結果を破棄する（成功=%s）', async (success) => {
  vi.useFakeTimers();
  const { peers, peer, page } = mountLive();
  let resolve!: (token: string) => void;
  let reject!: () => void;
  vi.mocked(sessionToken).mockImplementationOnce(
    () =>
      new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      }),
  );
  act(() => peer.onclose());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  page.unmount();
  await act(async () => {
    if (success) {
      resolve('token');
    } else {
      reject();
    }
  });
  expect(peers).toHaveLength(1);
});

test('前の許可結果が届いても、新しいマイク準備が終わるまで操作を無効に保つ', async () => {
  const { state, audio, click, peer, peers } = mountLive();
  const waits: ((value: typeof audio) => void)[] = [];
  vi.mocked(openInterviewAudio).mockImplementation(
    () => new Promise((resolve) => waits.push(resolve)),
  );
  state({ status: 'ready' });
  await click('マイクを許可して開始');
  act(() => peer.onclose());
  await click('再接続');
  act(() =>
    peers[1].onmessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'state',
          interviewId: 'live',
          generation: 2,
          status: 'ready',
          canControl: false,
          activeMs: 0,
          activeSince: null,
          deadline: null,
          updatedAt: 2,
          transcriptIncomplete: false,
          evaluationJobId: null,
        }),
      }),
    ),
  );
  await click('マイクを許可して開始');
  await act(async () => waits[0](audio));
  expect(
    screen.getByRole('button', { name: 'マイクを許可して開始' }).closest('fieldset')?.disabled,
  ).toBe(true);
  await act(async () => waits[1](audio));
  expect(peers[1].send).toHaveBeenCalledOnce();
});
