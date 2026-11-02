export const executionTiming = {
  aiTimeoutMs: 120_000,
  attemptLimitMs: 180_000,
  leaseDurationMs: 180_000,
  renewalIntervalMs: 30_000,
  saveRetryIntervalMs: 1_000,
  slotWaitMs: 30_000,
  takeoverGraceMs: 30_000,
} as const;
