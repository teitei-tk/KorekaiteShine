// 壁時計の補正やタイマーの早期発火に依存せず、実経過時間でscheduledを駆動する。
export function startScheduledInterval(
  callback: (elapsedMs: number) => void,
  intervalMs: number,
): () => void {
  const started = performance.now();
  const tick = () => {
    const now = performance.now();
    if (now < schedule.deadline) {
      schedule.timer = setTimeout(tick, Math.ceil(schedule.deadline - now));
      return;
    }
    schedule.deadline = now + intervalMs;
    schedule.timer = setTimeout(tick, intervalMs);
    callback(now - started);
  };
  const schedule = { deadline: started + intervalMs, timer: setTimeout(tick, intervalMs) };
  return () => clearTimeout(schedule.timer);
}
