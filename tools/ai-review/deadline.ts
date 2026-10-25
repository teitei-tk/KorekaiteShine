import { ReviewFailure } from './failure.ts';

export const REVIEW_TIME_MS = 30 * 60_000;
export function timeFailure(): ReviewFailure {
  return new ReviewFailure('TIME_BUDGET_EXCEEDED', '生成処理の時間上限を超えました');
}
export async function withReviewDeadline<T>(
  work: (signal: AbortSignal, check: () => void) => Promise<T>,
  milliseconds = REVIEW_TIME_MS,
  now: () => number = () => performance.now(),
): Promise<T> {
  const controller = new AbortController();
  const end = now() + milliseconds;
  const check = () => {
    if (controller.signal.aborted || now() >= end) {
      controller.abort();
      throw timeFailure();
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeFailure());
      controller.abort();
    }, milliseconds);
  });
  try {
    return await Promise.race([
      expired,
      Promise.resolve().then(async () => {
        check();
        const result = await work(controller.signal, check);
        check();
        return result;
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
