import { expect, test, vi } from 'vitest';
import { createStartupTiming, readStartupTiming } from '../src/startup-timing.ts';

test('起動の各段階と残り時間を単調時計で重複なく計測する', () => {
  const state = { now: 100 };
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => state.now);
  try {
    const timing = createStartupTiming();
    state.now += 2;
    timing.mark('lockMs');
    state.now += 3;
    timing.mark('artifactMs');
    state.now += 40;
    timing.mark('databaseMs');
    state.now += 5;
    timing.mark('filesAndConfigMs');
    state.now += 1;
    timing.mark('spawnMs');
    state.now += 60;
    timing.mark('urlReadyMs');
    state.now += 70;
    timing.mark('httpReadyMs');
    state.now += 4;
    expect(timing.finish()).toStrictEqual({
      lockMs: 2,
      artifactMs: 3,
      databaseMs: 40,
      filesAndConfigMs: 5,
      spawnMs: 1,
      urlReadyMs: 60,
      httpReadyMs: 70,
      coverageMs: 0,
      otherMs: 4,
      totalMs: 185,
    });
  } finally {
    clock.mockRestore();
  }
});

test('計測ファイルの欠落・負数を拒否し数値だけを読み込む', () => {
  const value = createStartupTiming().finish();
  expect(readStartupTiming(value)).toStrictEqual(value);
  expect(() => readStartupTiming(null)).toThrow();
  expect(() => readStartupTiming({})).toThrow();
  expect(() => readStartupTiming({ ...value, databaseMs: -1 })).toThrow();
  expect(() => readStartupTiming({ ...value, databaseMs: 'private' })).toThrow();
  expect(readStartupTiming({ ...value, extra: 'private' })).toStrictEqual(value);
});
