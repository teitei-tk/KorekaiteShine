import { usageLimits } from '@korekaite/runtime-config/limits';

export interface InterviewState {
  interviewId: string;
  status: 'ready' | 'connecting' | 'active' | 'paused' | 'reconnecting' | 'ending' | 'ended';
  generation: number;
  streamGeneration: number | null;
  activeMs: number;
  activeSince: number | null;
  deadline: number | null;
  updatedAt: number;
}

export type InterviewAction =
  | { type: 'connect'; deadline?: number }
  | { type: 'ready'; generation: number; deadline?: number }
  | { type: 'pause' | 'finish' | 'tick' | 'takeover' | 'persisted' }
  | { type: 'disconnected' | 'closed' | 'start_failed'; generation: number };

export function createInterviewState(interviewId: string): InterviewState {
  return {
    interviewId,
    status: 'ready',
    generation: 0,
    streamGeneration: null,
    activeMs: 0,
    activeSince: null,
    deadline: null,
    updatedAt: 0,
  };
}

export function canSendAudio(state: InterviewState, generation: number, now: number): boolean {
  return (
    state.status === 'active' &&
    state.generation === generation &&
    Number.isSafeInteger(now) &&
    now >= state.updatedAt &&
    state.deadline !== null &&
    now < state.deadline
  );
}

export function transitionInterview(
  state: InterviewState,
  action: InterviewAction,
  now: number,
): InterviewState {
  if (!Number.isSafeInteger(now) || now < state.updatedAt) {
    throw new Error('面接の時刻が不正です。');
  }
  if (
    action.type === 'start_failed' &&
    state.status === 'connecting' &&
    state.generation === action.generation &&
    state.activeMs === 0
  ) {
    return {
      ...state,
      status: 'ready',
      generation: state.generation + 1,
      streamGeneration: null,
      activeSince: null,
      deadline: null,
      updatedAt: now,
    };
  }
  if (action.type === 'closed') {
    return state.streamGeneration === action.generation
      ? { ...state, streamGeneration: null, updatedAt: now }
      : state;
  }
  if ('generation' in action && action.generation !== state.generation) {
    return state;
  }
  const next = { ...state, updatedAt: now };
  const activeEnd = state.deadline === null ? now : Math.min(now, state.deadline);
  const activeMs =
    state.activeMs + (state.activeSince === null ? 0 : activeEnd - state.activeSince);
  if (state.deadline !== null && now >= state.deadline) {
    return {
      ...next,
      status: 'ending',
      generation: state.generation + 1,
      activeMs,
      activeSince: null,
      deadline: null,
    };
  }
  switch (action.type) {
    case 'start_failed':
      return state;
    case 'connect':
      if (!['ready', 'paused', 'reconnecting'].includes(state.status)) {
        throw new Error('面接を接続できない状態です。');
      }
      return {
        ...next,
        status: 'connecting',
        generation: state.generation + 1,
        streamGeneration: state.generation + 1,
        activeSince: null,
        deadline: Math.min(state.deadline ?? Infinity, action.deadline ?? Infinity, now + 30_000),
      };
    case 'ready':
      if (state.status !== 'connecting') {
        throw new Error('接続待ちではありません。');
      }
      return {
        ...next,
        status: 'active',
        activeSince: now,
        deadline: Math.min(
          now + usageLimits.interviewActiveMs - state.activeMs,
          action.deadline ?? Infinity,
        ),
      };
    case 'disconnected':
      if (!['active', 'connecting'].includes(state.status)) {
        return state;
      }
      return {
        ...next,
        status: 'reconnecting',
        generation: state.generation + 1,
        activeMs,
        activeSince: null,
        deadline:
          state.status === 'connecting'
            ? Math.min(state.deadline ?? Infinity, now + 60_000)
            : now + 60_000,
      };
    case 'takeover':
      if (!['active', 'paused', 'reconnecting', 'connecting'].includes(state.status)) {
        throw new Error('引き継ぎできない状態です。');
      }
      return {
        ...next,
        status: 'connecting',
        generation: state.generation + 1,
        streamGeneration: state.generation + 1,
        activeMs,
        activeSince: null,
        deadline:
          state.status === 'active'
            ? now + 30_000
            : Math.min(state.deadline ?? Infinity, now + 30_000),
      };
    case 'pause':
      if (
        state.status !== 'reconnecting' &&
        (state.status !== 'active' || state.activeSince === null)
      ) {
        throw new Error('面接を一時停止できない状態です。');
      }
      return {
        ...next,
        status: 'paused',
        generation: state.generation + 1,
        activeMs,
        activeSince: null,
        deadline: now + 300_000,
      };
    case 'finish':
      if (state.status === 'ending' || state.status === 'ended') {
        return state;
      }
      return {
        ...next,
        status: 'ending',
        generation: state.generation + 1,
        activeMs,
        activeSince: null,
        deadline: null,
      };
    case 'tick':
      return state.status === 'ended' || state.status === 'ending' ? state : next;
    case 'persisted':
      if (state.status === 'ended') {
        return state;
      }
      if (state.status !== 'ending') {
        throw new Error('終了処理中ではありません。');
      }
      return { ...next, status: 'ended', streamGeneration: null };
  }
}
