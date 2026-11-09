import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';
import { encodeMicrophoneFrame, createPlayback } from '../src/lib/practice-audio';

test('入力の世代ヘッダーとPCM16のバイト順を保ち、空・過大なフレームを拒否する', () => {
  const frame = encodeMicrophoneFrame(3, Uint8Array.from([0, 128, 255, 127]).buffer);
  expect(new DataView(frame).getFloat64(0)).toBe(3);
  expect([...new Uint8Array(frame, 8)]).toEqual([0, 128, 255, 127]);
  expect(() => encodeMicrophoneFrame(0, new ArrayBuffer(2))).toThrow();
  for (const length of [0, 3, 9602]) {
    expect(() => encodeMicrophoneFrame(1, new ArrayBuffer(length))).toThrow();
  }
});

test('AudioWorkletは24kHzの入力を20msごとのPCM16に変換する', () => {
  const send = vi.fn();
  let create!: () => { process(inputs: Float32Array[][]): boolean };
  runInNewContext(
    readFileSync(new URL('../src/lib/microphone-worklet.js', import.meta.url), 'utf8'),
    {
      AudioWorkletProcessor: class {
        port = { postMessage: send };
      },
      registerProcessor: (_name: string, Processor: new () => ReturnType<typeof create>) => {
        create = () => new Processor();
      },
    },
  );
  const processor = create();
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
  sources[0].onended!();
  playback.stop();
  sources[1].onended?.();
  expect(acknowledge.mock.calls).toEqual([[20]]);
});
