import type { JsonValue } from '@korekaite/api-contracts/json';
import { isObject } from './records.ts';
const emptyTiming = () => ({
  lockMs: 0,
  artifactMs: 0,
  databaseMs: 0,
  filesAndConfigMs: 0,
  spawnMs: 0,
  urlReadyMs: 0,
  httpReadyMs: 0,
  coverageMs: 0,
  otherMs: 0,
  totalMs: 0,
});
export type StartupTiming = ReturnType<typeof emptyTiming>;
type Phase = Exclude<keyof StartupTiming, 'otherMs' | 'totalMs'>;
export function createStartupTiming() {
  const started = performance.now();
  const state = { previous: started };
  const values = emptyTiming();
  return {
    mark(phase: Phase) {
      const now = performance.now();
      values[phase] += now - state.previous;
      state.previous = now;
    },
    finish(): StartupTiming {
      const now = performance.now();
      return { ...values, otherMs: now - state.previous, totalMs: now - started };
    },
  };
}
export function readStartupTiming(input: JsonValue): StartupTiming {
  if (!isObject(input)) {
    throw new Error('起動計測が不正です。');
  }
  const result = emptyTiming();
  for (const key of [
    'lockMs',
    'artifactMs',
    'databaseMs',
    'filesAndConfigMs',
    'spawnMs',
    'urlReadyMs',
    'httpReadyMs',
    'coverageMs',
    'otherMs',
    'totalMs',
  ] as const) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error('起動計測の時間が不正です。');
    }
    result[key] = value;
  }
  return result;
}
