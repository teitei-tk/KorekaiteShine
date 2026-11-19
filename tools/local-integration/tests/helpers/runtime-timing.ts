import { AsyncLocalStorage } from 'node:async_hooks';
import { test as baseTest } from 'vitest';

type Phase = 'startup' | 'database' | 'build' | 'shutdown';
type Span = { phase: Phase; start: number; end: number };
const context = new AsyncLocalStorage<Span[]>();
function covered(spans: Span[]): number {
  const state = { end: 0, duration: 0 };
  const ordered: Span[] = [];
  for (const span of spans) {
    const index = ordered.findIndex((item) => item.start > span.start);
    ordered.splice(index === -1 ? ordered.length : index, 0, span);
  }
  for (const span of ordered) {
    state.duration += Math.max(0, span.end - Math.max(state.end, span.start));
    state.end = Math.max(state.end, span.end);
  }
  return state.duration;
}
export function measureSyncOperation<T>(phase: Phase, operation: () => T): T {
  const spans = context.getStore();
  const start = performance.now();
  try {
    return operation();
  } finally {
    spans?.push({ phase, start, end: performance.now() });
  }
}
export async function measureOperation<T>(phase: Phase, operation: () => Promise<T>): Promise<T> {
  const spans = context.getStore();
  const start = performance.now();
  try {
    return await operation();
  } finally {
    spans?.push({ phase, start, end: performance.now() });
  }
}
export async function profileCase<T>(
  file: string,
  index: number,
  operation: () => Promise<T> | T,
): Promise<T> {
  const spans: Span[] = [];
  const start = performance.now();
  try {
    return await context.run(spans, operation);
  } finally {
    const totalMs = performance.now() - start;
    const phases = ['startup', 'database', 'build', 'shutdown'] as const;
    const times = phases.map((phase) => covered(spans.filter((span) => span.phase === phase)));
    const busyMs = covered(spans);
    process.stdout.write(
      `boundary-timing ${JSON.stringify({
        file,
        case: index,
        totalMs,
        startupMs: times[0],
        databaseMs: times[1],
        buildMs: times[2],
        shutdownMs: times[3],
        checksMs: Math.max(0, totalMs - busyMs),
        overlapMs: Math.max(0, times.reduce((sum, value) => sum + value, 0) - busyMs),
        calls: Object.fromEntries(
          phases.map((phase) => [phase, spans.filter((span) => span.phase === phase).length]),
        ),
      })}\n`,
    );
  }
}
export function measuredTests(file: string) {
  const state = { index: 0 };
  return (name: string, operation: () => Promise<void> | void, timeout?: number) => {
    state.index += 1;
    const caseIndex = state.index;
    baseTest(name, () => profileCase(file, caseIndex, operation), timeout);
  };
}
