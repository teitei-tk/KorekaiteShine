import { afterEach, expect, test, vi } from 'vitest';
import {
  installMediaProbe,
  fakeMediaArgs,
  playbackCount,
  speak,
  waitForPlayback,
  waitForOpening,
} from '../media.mjs';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
test('マイクの発話区間とスピーカーに到達した非無音の再生だけを記録する', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', {});
  const context = { addInitScript: (fn) => fn() };
  await installMediaProbe(context);
  expect(window.voiceE2e).toBeUndefined();
  const track = { enabled: true, readyState: 'live' };
  navigator.mediaDevices = { getUserMedia: async () => ({ getAudioTracks: () => [track] }) };
  const amplitudeState = { amplitude: 0 };
  const analyser = {
    fftSize: 8,
    getFloatTimeDomainData: (array) => array.fill(amplitudeState.amplitude),
  };
  class FakeNode {
    connect(dest) {
      return dest;
    }
  }
  vi.stubGlobal('AudioNode', FakeNode);
  vi.stubGlobal('AudioBufferSourceNode', class extends FakeNode {});
  await installMediaProbe(context);
  expect(() => window.voiceE2e.speak()).toThrow('マイク');
  await navigator.mediaDevices.getUserMedia({ audio: true });
  expect(track.enabled).toBe(false);
  const node = new FakeNode();
  node.context = {
    state: 'running',
    currentTime: 0,
    destination: {},
    createAnalyser: vi.fn(() => analyser),
  };
  node.connect({});
  node.connect(node.context.destination);
  node.connect(node.context.destination);
  expect(node.context.createAnalyser).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(20);
  node.context.currentTime = 0.1;
  vi.advanceTimersByTime(20);
  expect(window.voiceE2e.count).toBe(0);
  amplitudeState.amplitude = 0.1;
  node.context.currentTime = 0.2;
  vi.advanceTimersByTime(20);
  expect(window.voiceE2e.count).toBe(1);
  const page = { evaluate: (fn) => fn(), waitForFunction: vi.fn(async (fn, arg) => fn(arg)) };
  expect(await playbackCount(page)).toBe(1);
  await speak(page);
  expect(track.enabled).toBe(true);
  expect(page.waitForFunction.mock.lastCall[0]()).toBe(false);
  node.context.state = 'closed';
  vi.advanceTimersByTime(3900);
  expect(track.enabled).toBe(false);
  expect(page.waitForFunction.mock.lastCall[0]()).toBe(true);
  expect(await waitForPlayback(page, 0)).toBe(1);
  track.readyState = 'ended';
  expect(() => window.voiceE2e.speak()).toThrow('マイク');
  expect(vi.getTimerCount()).toBe(0);
  expect(fakeMediaArgs.join(' ')).toContain('answer.wav');
});

test('初回質問の100msだけでは通さず、模擬質問500msの再生終了を確認する', async () => {
  vi.stubGlobal('window', {
    voiceE2e: { count: 8, audibleSeconds: 0.1, completedSeconds: 0.1, lastSound: -1000 },
  });
  const page = {
    evaluate: (fn) => fn(),
    waitForFunction: async (fn, arg) => {
      if (!fn(arg)) {
        throw new Error('再生が不足');
      }
    },
  };
  await expect(waitForOpening(page, 0)).rejects.toThrow('再生が不足');
  window.voiceE2e.audibleSeconds = 0.46;
  window.voiceE2e.completedSeconds = 0.46;
  await expect(waitForOpening(page, 0)).rejects.toThrow('再生が不足');
  vi.stubEnv('E2E_PROFILE', 'live');
  await expect(waitForOpening(page, 0)).resolves.toBeUndefined();
  vi.stubEnv('E2E_PROFILE', 'pr');
  window.voiceE2e.completedSeconds = 0.5;
  await expect(waitForOpening(page, 0)).resolves.toBeUndefined();
});

test('再生予定のバッファのうち実際に再生済みの区間だけで周波数・発音時間を集計する', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
  class Node {
    connect(target) {
      return target;
    }
  }
  class Source extends Node {
    start = vi.fn();
    addEventListener(_type, listener) {
      this.ended = listener;
    }
  }
  vi.stubGlobal('AudioNode', Node);
  vi.stubGlobal('AudioBufferSourceNode', Source);
  await installMediaProbe({ addInitScript: (fn) => fn() });
  const source = new Source();
  const samples = new Float32Array(4800);
  for (const i of samples.subarray(0, 2400).keys()) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / 24000);
  }
  source.buffer = { sampleRate: 24000, getChannelData: () => samples };
  source.context = { currentTime: 0, destination: {}, createAnalyser: () => ({ fftSize: 8 }) };
  source.connect(source.context.destination);
  source.start();
  source.context.currentTime = 0.05;
  source.ended();
  expect(window.voiceE2e.playedFrequencies).toEqual([]);
  source.start(1);
  source.ended();
  expect(window.voiceE2e.completedSeconds).toBeCloseTo(0.05);
  source.start(1);
  source.context.currentTime = 1.2;
  source.ended();
  expect(window.voiceE2e.playedFrequencies).toHaveLength(1);
  expect(window.voiceE2e.playedFrequencies[0]).toBeCloseTo(220, 0);
  expect(window.voiceE2e.completedSeconds).toBeCloseTo(0.25);
  expect(window.voiceE2e.audibleSeconds).toBeCloseTo(0.15);
});
