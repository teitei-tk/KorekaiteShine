import { afterEach, expect, test, vi } from 'vitest';
import {
  installMediaProbe,
  fakeMediaArgs,
  playbackCount,
  speak,
  waitForPlayback,
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
