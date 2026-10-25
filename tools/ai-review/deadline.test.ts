import { expect, it, vi } from 'vitest';
import { withReviewDeadline } from './deadline.ts';
it('期限内は結果を返し、次の実行に期限を持ち越さない', async () => {
  for (let i = 0; i < 2; i++)
    expect(
      await withReviewDeadline(async (_signal, check) => {
        check();
        return 1;
      }, 100),
    ).toBe(1);
});
it('実行中の時間切れはabortを通知し固定理由で停止する', async () => {
  vi.useFakeTimers();
  try {
    let aborted = false;
    const task = withReviewDeadline(
      async (signal) =>
        new Promise<void>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      100,
    );
    const rejected = expect(task).rejects.toMatchObject({ reason: 'TIME_BUDGET_EXCEEDED' });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
it('イベントループのタイマーが未実行でも期限後の次の呼び出しを拒否する', async () => {
  let now = 0,
    calls = 0;
  await expect(
    withReviewDeadline(
      async (_signal, check) => {
        check();
        calls++;
        now = 100;
        check();
        calls++;
      },
      100,
      () => now,
    ),
  ).rejects.toMatchObject({ reason: 'TIME_BUDGET_EXCEEDED' });
  expect(calls).toBe(1);
});
