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
  let amplitude = 0;
  const analyser = { fftSize: 8, getFloatTimeDomainData: (array) => array.fill(amplitude) };
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
  amplitude = 0.1;
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
  window.voiceE2e.completedSeconds = 0.5;
  await expect(waitForOpening(page, 0)).resolves.toBeUndefined();
});
