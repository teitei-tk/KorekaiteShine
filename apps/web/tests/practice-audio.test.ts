import { expect, test, vi } from 'vitest';
import {
  encodeMicrophoneFrame,
  createPlayback,
  openInterviewAudio,
} from '../src/lib/practice-audio';

test('入力の世代ヘッダーとPCM16のバイト順を保ち、空・過大なフレームを拒否する', () => {
  const frame = encodeMicrophoneFrame(3, Uint8Array.from([0, 128, 255, 127]).buffer);
  expect(new DataView(frame).getFloat64(0)).toBe(3);
  expect([...new Uint8Array(frame, 8)]).toEqual([0, 128, 255, 127]);
  expect(() => encodeMicrophoneFrame(0, new ArrayBuffer(2))).toThrow();
  for (const length of [0, 3, 9602]) {
    expect(() => encodeMicrophoneFrame(1, new ArrayBuffer(length))).toThrow();
  }
});

test('AudioWorkletは24kHzの入力を20msごとのPCM16に変換する', async () => {
  const send = vi.fn();
  let create!: () => { process(inputs: Float32Array[][]): boolean };
  vi.stubGlobal(
    'AudioWorkletProcessor',
    class {
      port = { postMessage: send };
    },
  );
  vi.stubGlobal(
    'registerProcessor',
    (name: string, Processor: new () => ReturnType<typeof create>) => {
      expect(name).toBe('interview-microphone');
      create = () => new Processor();
    },
  );
  try {
    const workletModule = '../src/lib/microphone-worklet.js';
    await import(workletModule);
  } finally {
    vi.unstubAllGlobals();
  }
  const processor = create();
  expect(processor.process([])).toBe(true);
  processor.process([[new Float32Array(128).fill(-1)]]);
  processor.process([[new Float32Array(128).fill(1)]]);
  processor.process([[new Float32Array(128).fill(0)]]);
  expect(send).not.toHaveBeenCalled();
  processor.process([[new Float32Array(128).fill(0.5)]]);
  const view = new DataView(send.mock.calls[0][0]);
  expect(view.byteLength).toBe(960);
  expect(view.getInt16(0, true)).toBe(-32768);
  expect(view.getInt16(256, true)).toBe(32767);
});

test('再生が自然に終了した位置だけ確認し、停止した音声は確認しない', () => {
  const sources: {
    onended: (() => void) | null;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const context = {
    currentTime: 1,
    destination: {},
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => {
      const source = {
        onended: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(source);
      return source;
    },
  };
  const playback = createPlayback(context as never);
  const acknowledge = vi.fn();
  playback.play(new ArrayBuffer(960), () => acknowledge(20));
  playback.play(new ArrayBuffer(960), () => acknowledge(40));
  expect(sources[1].start.mock.calls[0][0]).toBeCloseTo(1.02);
  const ended = sources[0].onended!;
  ended();
  ended();
  playback.stop();
  sources[1].onended?.();
  expect(acknowledge.mock.calls).toEqual([[20]]);
});

test('再生バッファの不正なサイズ、5秒の遅延、256個を超える同時再生を拒否する', () => {
  const context = {
    currentTime: 0,
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => ({ connect: vi.fn(), start: vi.fn() }),
  };
  const playback = createPlayback(context as never);
  for (const length of [0, 1, 98306]) {
    expect(() => playback.play(new ArrayBuffer(length), vi.fn())).toThrow('形式');
  }
  playback.play(new ArrayBuffer(98304), vi.fn());
  playback.play(new ArrayBuffer(98304), vi.fn());
  expect(() => playback.play(new ArrayBuffer(98304), vi.fn())).toThrow('追いついて');
  const queue = createPlayback(context as never);
  for (let index = 0; index < 256; index++) {
    queue.play(new ArrayBuffer(2), vi.fn());
  }
  expect(() => queue.play(new ArrayBuffer(2), vi.fn())).toThrow('追いついて');
});

function microphone(sampleRate = 24000) {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const input = { connect: vi.fn(), disconnect: vi.fn() };
  const port = { close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  const getUserMedia = vi.fn(async () => stream);
  const close = vi.fn().mockRejectedValue(new Error('already closed'));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = sampleRate;
      resume = vi.fn().mockResolvedValue(undefined);
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
      createMediaStreamSource = () => input;
      close = close;
    },
  );
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port = port;
      connect = vi.fn();
      disconnect = vi.fn();
    },
  );
  return { track, stream, input, port, getUserMedia, close };
}

test('取得した音声だけを転送し、トラック終了と解放を一度ずつ通知する', async () => {
  const { track, port, close } = microphone();
  try {
    const captured = vi.fn();
    const lost = vi.fn();
    const audio = await openInterviewAudio(new AbortController().signal, captured, lost);
    const deliver = port.onmessage!;
    const event = new MessageEvent('message', { data: new ArrayBuffer(2) });
    deliver(event);
    track.dispatchEvent(new Event('ended'));
    audio.close();
    audio.close();
    deliver(event);
    track.dispatchEvent(new Event('ended'));
    expect(captured).toHaveBeenCalledExactlyOnceWith(event.data);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('マイク権限待ちの中断と非対応レートでトラックを解放する', async () => {
  const { track, stream, getUserMedia } = microphone(44100);
  try {
    const abort = new AbortController();
    let allow!: (acquired: typeof stream) => void;
    getUserMedia.mockReturnValueOnce(
      new Promise((resolve) => {
        allow = resolve;
      }),
    );
    const opening = openInterviewAudio(abort.signal, vi.fn(), vi.fn());
    abort.abort();
    allow(stream);
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      openInterviewAudio(new AbortController().signal, vi.fn(), vi.fn()),
    ).rejects.toThrow('24 kHz');
    expect(track.stop).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
