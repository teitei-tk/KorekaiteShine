import { expect, test } from 'vitest';
import { createResponseMonitor } from '../src/lib/practice-response';

function frameTimes(start: number, end: number) {
  return Array.from({ length: (end - start) / 20 }, (_, index) => start + index * 20);
}

test('無音や短い物音では案内せず、発話後に応答が途絶えた場合だけ案内する', () => {
  const monitor = createResponseMonitor();
  const voice = new Int16Array(480).fill(1500).buffer;
  const quiet = new Int16Array(480).buffer;
  monitor.capture(new ArrayBuffer(0), 0);
  monitor.capture(quiet, 0);
  monitor.capture(voice, 20);
  monitor.capture(quiet, 40);
  expect(monitor.isWaitingTooLong(60000)).toBe(false);
  for (const t of frameTimes(60000, 60200)) {
    monitor.capture(voice, t);
  }
  expect(monitor.isWaitingTooLong(70000)).toBe(false);
  expect(monitor.isWaitingTooLong(81000)).toBe(true);
  monitor.reset();
  expect(monitor.isWaitingTooLong(120000)).toBe(false);
});

test('最初の質問は無音や100msの断片では待機を解除せず、再生済みの音声を合算する', () => {
  const monitor = createResponseMonitor();
  monitor.expectOpening(0);
  monitor.played(new Int16Array(12000).buffer);
  monitor.played(new Int16Array(2400).fill(1200).buffer);
  expect(monitor.isWaitingTooLong(20000)).toBe(true);
  monitor.played(new Int16Array(7200).fill(1200).buffer);
  expect(monitor.isWaitingTooLong(20001)).toBe(false);
});

test('小声の回答を検知し、一定の背景音が続いても案内が先送りされない', () => {
  const monitor = createResponseMonitor();
  const quietVoice = new Int16Array(480).fill(30).buffer;
  for (const t of frameTimes(0, 200)) {
    monitor.capture(quietVoice, t);
  }
  expect(monitor.isWaitingTooLong(20200)).toBe(true);
  monitor.reset();
  for (const t of frameTimes(0, 24000)) {
    monitor.capture(new Int16Array(480).fill(t < 200 ? 1500 : 490).buffer, t);
  }
  expect(monitor.isWaitingTooLong(24000)).toBe(true);
});

test('強弱のある回答を20秒以上話し続けている間は待機案内を出さない', () => {
  const monitor = createResponseMonitor();
  const loud = new Int16Array(480).fill(1600).buffer;
  const soft = new Int16Array(480).fill(200).buffer;
  for (const t of frameTimes(0, 30000)) {
    monitor.capture(t % 400 < 200 ? loud : soft, t);
  }
  expect(monitor.isWaitingTooLong(30000)).toBe(false);
  expect(monitor.isWaitingTooLong(51000)).toBe(true);
});

test('先に届いた質問の再生終了で、重ねて話した回答の待機を解除しない', () => {
  const monitor = createResponseMonitor();
  monitor.expectOpening(0);
  const question = monitor.playbackVersion();
  const bytes = new Int16Array(480).fill(1800).buffer;
  for (const t of frameTimes(1000, 1500)) {
    monitor.capture(bytes, t);
  }
  monitor.played(new Int16Array(24000).fill(1200).buffer, question);
  expect(monitor.isWaitingTooLong(22000)).toBe(true);
});

test('言い換えを依頼する前の音声は新しい返答に数えない', () => {
  const monitor = createResponseMonitor();
  const old = monitor.playbackVersion();
  monitor.expectOpening(2000);
  monitor.played(new Int16Array(24000).fill(1200).buffer, old);
  expect(monitor.isWaitingTooLong(22500)).toBe(true);
});
