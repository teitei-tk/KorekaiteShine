import { expect, test, vi } from 'vitest';
import { measureOperation, profileCase } from './helpers/runtime-timing.ts';

test('起動・DB操作と検証を分離し、失敗の時間と例外を保持する', async () => {
  const clockState = { now: 0 };
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => clockState.now);
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const failure = new Error('not for logs');
  try {
    await expect(
      profileCase('unit', 1, async () => {
        await measureOperation('startup', async () => {
          clockState.now += 10;
        });
        await measureOperation('database', async () => {
          clockState.now += 20;
        });
        clockState.now += 5;
        await measureOperation('shutdown', async () => {
          clockState.now += 2;
          throw failure;
        });
      }),
    ).rejects.toBe(failure);
    expect(output).toHaveBeenCalledWith(
      'boundary-timing {"file":"unit","case":1,"totalMs":37,"startupMs":10,"databaseMs":20,"buildMs":0,"shutdownMs":2,"checksMs":5,"overlapMs":0,"calls":{"startup":1,"database":1,"build":0,"shutdown":1}}\n',
    );
  } finally {
    clock.mockRestore();
    output.mockRestore();
  }
});

test('重なった計測を検証時間から二重に引かない', async () => {
  const state = { now: 0 };
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => state.now);
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await profileCase('unit', 2, () =>
      measureOperation('startup', async () => {
        state.now += 5;
        await measureOperation('database', async () => {
          state.now += 5;
        });
      }),
    );
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"checksMs":0,"overlapMs":5'));
  } finally {
    clock.mockRestore();
    output.mockRestore();
  }
});

test('同期DBコマンドも同期の戻り値と例外を保持して計測する', async () => {
  const { measureSyncOperation } = await import('./helpers/runtime-timing.ts');
  const state = { now: 0 };
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => state.now);
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await profileCase('unit', 3, () => {
      const result = measureSyncOperation('database', () => {
        state.now += 4;
        return 7;
      });
      expect(result).toBe(7);
      expect(() =>
        measureSyncOperation('database', () => {
          state.now += 3;
          throw new Error('private');
        }),
      ).toThrow('private');
    });
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"databaseMs":7'));
  } finally {
    clock.mockRestore();
    output.mockRestore();
  }
});
