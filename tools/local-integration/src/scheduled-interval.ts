// 壁時計の補正やタイマーの早期発火に依存せず、実経過時間でscheduledを駆動する。
export function startScheduledInterval(
  callback: (elapsedMs: number) => void,
  intervalMs: number,
): () => void {
  const started = performance.now();
  let deadline = started + intervalMs;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const now = performance.now();
    if (now < deadline) {
      timer = setTimeout(tick, Math.ceil(deadline - now));
      return;
    }
    deadline = now + intervalMs;
    timer = setTimeout(tick, intervalMs);
    callback(now - started);
  };
  timer = setTimeout(tick, intervalMs);
  return () => clearTimeout(timer);
}
