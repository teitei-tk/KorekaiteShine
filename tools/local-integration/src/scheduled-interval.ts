// 壁時計の補正やタイマーの早期発火に依存せず、実経過時間でscheduledを駆動する。
export function startScheduledInterval(
  callback: (elapsedMs: number) => void,
  intervalMs: number,
): () => void {
  const started = performance.now();
  const schedule: { deadline: number; timer?: ReturnType<typeof setTimeout> } = {
    deadline: started + intervalMs,
  };
  function tick(): void {
    const now = performance.now();
    if (now < schedule.deadline) {
      schedule.timer = setTimeout(tick, Math.ceil(schedule.deadline - now));
      return;
    }
    schedule.deadline = now + intervalMs;
    schedule.timer = setTimeout(tick, intervalMs);
    callback(now - started);
  }
  schedule.timer = setTimeout(tick, intervalMs);
  return () => {
    clearTimeout(schedule.timer);
  };
}
