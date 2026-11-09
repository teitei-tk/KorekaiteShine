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
  state('ended', 2, false);
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
    for (let second = 1; second < 65; second++) {
      act(() => peers.at(-1)?.onclose?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    const count = peers.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(peers.length).toBe(count);
    expect(count).toBeLessThan(20);
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
