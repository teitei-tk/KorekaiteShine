import { expect, test } from 'vitest';
import {
  canSendAudio,
  createInterviewState,
  transitionInterview,
} from '../src/domain/interview-state';

test('音声送信を止めても上流終了まで文字起こしの受信世代を保持する', () => {
  const connecting = transitionInterview(createInterviewState('a'), { type: 'connect' }, 0);
  const active = transitionInterview(connecting, { type: 'ready', generation: 1 }, 1);
  const ending = transitionInterview(active, { type: 'finish' }, 100);
  expect(ending).toMatchObject({ generation: 2, streamGeneration: 1, status: 'ending' });
  expect(canSendAudio(ending, 1, 100)).toBe(false);
  expect(transitionInterview(ending, { type: 'closed', generation: 0 }, 101)).toEqual(ending);
  expect(
    transitionInterview(ending, { type: 'closed', generation: 1 }, 101).streamGeneration,
  ).toBeNull();
  const takeover = transitionInterview(active, { type: 'takeover' }, 100);
  expect(takeover.streamGeneration).toBe(2);
  expect(transitionInterview(takeover, { type: 'closed', generation: 1 }, 101)).toEqual(takeover);
});

test('接続確認後だけ時間を計測し、一時停止中は計測せず同じ面接を再開する', () => {
  const initial = createInterviewState('interview-a');
  const connecting = transitionInterview(initial, { type: 'connect' }, 1_000);
  expect(connecting).toMatchObject({ status: 'connecting', generation: 1, activeMs: 0 });
  const active = transitionInterview(connecting, { type: 'ready', generation: 1 }, 3_000);
  const paused = transitionInterview(active, { type: 'pause' }, 13_000);
  expect(paused).toMatchObject({
    interviewId: 'interview-a',
    status: 'paused',
    activeMs: 10_000,
    activeSince: null,
    deadline: 313_000,
  });
  expect(active.status).toBe('active');
  const reconnecting = transitionInterview(paused, { type: 'connect' }, 200_000);
  const resumed = transitionInterview(
    reconnecting,
    { type: 'ready', generation: reconnecting.generation },
    205_000,
  );
  const ending = transitionInterview(resumed, { type: 'finish' }, 210_000);
  expect(ending).toMatchObject({ interviewId: 'interview-a', status: 'ending', activeMs: 15_000 });
  expect(transitionInterview(ending, { type: 'finish' }, 220_000)).toEqual(ending);
});

test('停止5分・接続30秒の期限ちょうどで終了し、直前の再接続で延長しない', () => {
  const connecting = transitionInterview(createInterviewState('a'), { type: 'connect' }, 0);
  expect(transitionInterview(connecting, { type: 'tick' }, 29_999).status).toBe('connecting');
  expect(transitionInterview(connecting, { type: 'tick' }, 30_000).status).toBe('ending');
  const active = transitionInterview(connecting, { type: 'ready', generation: 1 }, 0);
  const paused = transitionInterview(active, { type: 'pause' }, 1_000);
  expect(transitionInterview(paused, { type: 'tick' }, 300_999).status).toBe('paused');
  expect(transitionInterview(paused, { type: 'tick' }, 301_000)).toMatchObject({
    status: 'ending',
    activeMs: 1_000,
  });
  const retrying = transitionInterview(paused, { type: 'connect' }, 300_999);
  expect(retrying.deadline).toBe(301_000);
  expect(
    transitionInterview(retrying, { type: 'ready', generation: retrying.generation }, 301_000)
      .status,
  ).toBe('ending');
});

test('切断後は1分待ち、引き継ぎ前の世代から届くイベントで状態を変更しない', () => {
  const connecting = transitionInterview(createInterviewState('a'), { type: 'connect' }, 0);
  const active = transitionInterview(connecting, { type: 'ready', generation: 1 }, 1_000);
  const disconnected = transitionInterview(active, { type: 'disconnected', generation: 1 }, 11_000);
  expect(disconnected).toMatchObject({
    status: 'reconnecting',
    generation: 2,
    activeMs: 10_000,
    deadline: 71_000,
  });
  expect(transitionInterview(disconnected, { type: 'tick' }, 71_000).status).toBe('ending');
  expect(transitionInterview(disconnected, { type: 'pause' }, 15_000)).toMatchObject({
    status: 'paused',
    activeMs: 10_000,
    activeSince: null,
    deadline: 315_000,
  });
  expect(transitionInterview(disconnected, { type: 'pause' }, 71_000).status).toBe('ending');
  const takeover = transitionInterview(active, { type: 'takeover' }, 11_000);
  expect(takeover).toMatchObject({ status: 'connecting', generation: 2, activeMs: 10_000 });
  expect(transitionInterview(takeover, { type: 'ready', generation: 1 }, 12_000)).toEqual(takeover);
  expect(transitionInterview(takeover, { type: 'disconnected', generation: 1 }, 12_000)).toEqual(
    takeover,
  );
  const newActive = transitionInterview(takeover, { type: 'ready', generation: 2 }, 12_000);
  expect(newActive).toMatchObject({ status: 'active', generation: 2, activeMs: 10_000 });
});

test('20分の上限で計測を止め、終了保存の完了後は再開しない', () => {
  const connecting = transitionInterview(createInterviewState('a'), { type: 'connect' }, 0);
  const active = transitionInterview(connecting, { type: 'ready', generation: 1 }, 1_000);
  const ending = transitionInterview(active, { type: 'tick' }, 1_210_000);
  expect(ending).toMatchObject({ status: 'ending', activeMs: 1_200_000, activeSince: null });
  expect(() => transitionInterview(active, { type: 'persisted' }, 2_000)).toThrow();
  const ended = transitionInterview(ending, { type: 'persisted' }, 1_211_000);
  expect(ended.status).toBe('ended');
  expect(transitionInterview(ended, { type: 'finish' }, 1_212_000)).toEqual(ended);
  expect(transitionInterview(ended, { type: 'tick' }, 1_212_000)).toEqual(ended);
  expect(() => transitionInterview(ended, { type: 'connect' }, 1_212_000)).toThrow();
  for (const now of [-1, NaN, Infinity, 999]) {
    expect(() => transitionInterview(active, { type: 'pause' }, now)).toThrow();
  }
});

test('音声は接続確認済みの現世代だけが期限内に送信できる', () => {
  const connecting = transitionInterview(createInterviewState('a'), { type: 'connect' }, 0);
  expect(canSendAudio(connecting, 1, 100)).toBe(false);
  const active = transitionInterview(connecting, { type: 'ready', generation: 1 }, 1_000);
  expect(canSendAudio(active, 1, 1_000)).toBe(true);
  expect(canSendAudio(active, 0, 1_000)).toBe(false);
  expect(canSendAudio(active, 1, 1_201_000)).toBe(false);
  expect(canSendAudio(active, 1, NaN)).toBe(false);
  expect(canSendAudio(active, 1, 999)).toBe(false);
  const paused = transitionInterview(active, { type: 'pause' }, 2_000);
  expect(canSendAudio(paused, paused.generation, 2_000)).toBe(false);
  const ending = transitionInterview(active, { type: 'finish' }, 2_000);
  expect(canSendAudio(ending, ending.generation, 2_000)).toBe(false);
});

test('状態に合わない通知を無視し、開始前の制御操作を拒否する', () => {
  const state = createInterviewState('a');
  expect(transitionInterview(state, { type: 'disconnected', generation: 0 }, 1)).toBe(state);
  expect(transitionInterview(state, { type: 'closed', generation: 0 }, 1)).toBe(state);
  expect(transitionInterview(state, { type: 'start_failed', generation: 0 }, 1)).toBe(state);
  for (const action of [
    { type: 'ready', generation: 0 },
    { type: 'pause' },
    { type: 'takeover' },
  ] as const) {
    expect(() => transitionInterview(state, action, 1)).toThrow();
  }
  const connecting = transitionInterview(state, { type: 'connect' }, 0);
  expect(transitionInterview(connecting, { type: 'takeover' }, 200).deadline).toBe(30000);
  const ending = transitionInterview(connecting, { type: 'finish' }, 1);
  expect(transitionInterview(ending, { type: 'tick' }, 2)).toBe(ending);
  const ended = transitionInterview(ending, { type: 'persisted' }, 2);
  expect(transitionInterview(ended, { type: 'persisted' }, 3)).toBe(ended);
});

test('期限が未設定の保存状態でも再接続と引き継ぎに新しい期限を設定する', () => {
  const state = { ...createInterviewState('a'), status: 'connecting' as const, generation: 1 };
  expect(transitionInterview(state, { type: 'disconnected', generation: 1 }, 100).deadline).toBe(
    60100,
  );
  expect(transitionInterview(state, { type: 'takeover' }, 100).deadline).toBe(30100);
});
