import { isRecord } from './json.ts';
type Sample = { id: string; identity: string; durationMs: number; sampledAt?: string };
export type History = {
  schema: 1;
  id: string;
  repository: string;
  workflow: string;
  event: 'push';
  branch: 'main';
  conclusion: 'success';
  createdAt: string;
  samples: Sample[];
};
type TimingData = Omit<History, 'event' | 'branch' | 'conclusion'>;
function isTimingData(value: unknown): value is TimingData {
  return (
    isRecord(value) &&
    value.schema === 1 &&
    typeof value.id === 'string' &&
    typeof value.repository === 'string' &&
    typeof value.workflow === 'string' &&
    typeof value.createdAt === 'string' &&
    Array.isArray(value.samples) &&
    value.samples.every(
      (sample: unknown) =>
        isRecord(sample) &&
        typeof sample.id === 'string' &&
        typeof sample.identity === 'string' &&
        typeof sample.durationMs === 'number' &&
        Number.isFinite(sample.durationMs) &&
        sample.durationMs > 0 &&
        (sample.sampledAt === undefined || typeof sample.sampledAt === 'string'),
    )
  );
}
function isHistory(value: unknown): value is History {
  return (
    isTimingData(value) &&
    'event' in value &&
    value.event === 'push' &&
    'branch' in value &&
    value.branch === 'main' &&
    'conclusion' in value &&
    value.conclusion === 'success'
  );
}
export function readHistory(
  input: unknown,
  context: { repository: string; workflow: string; now: number },
  identity: string,
): { id: string | null; durations: Record<string, number> } {
  return readTimingData(isHistory(input) ? input : null, context, identity);
}
export function readWeights(
  history: unknown,
  seed: unknown,
  context: { repository: string; workflow: string; now: number },
  identity: string,
): { id: string | null; durations: Record<string, number>; sources: string[] } {
  const validSeed =
    isRecord(seed) &&
    isRecord(seed.source) &&
    Number.isSafeInteger(seed.source.runId) &&
    typeof seed.source.runId === 'number' &&
    seed.source.runId > 0 &&
    Number.isSafeInteger(seed.source.attempt) &&
    typeof seed.source.attempt === 'number' &&
    seed.source.attempt > 0 &&
    typeof seed.source.headSha === 'string' &&
    /^[a-f0-9]{40}$/u.test(seed.source.headSha) &&
    seed.source.conclusion === 'success' &&
    seed.id === `reviewed-run:${seed.source.runId}:${seed.source.attempt}`;
  const initial = readTimingData(validSeed ? seed : null, context, identity);
  const main = readHistory(history, context, identity);
  const sources = [
    ...(initial.id &&
    Object.keys(initial.durations).some((id) => !Object.hasOwn(main.durations, id))
      ? [initial.id]
      : []),
    ...(main.id && Object.keys(main.durations).length > 0 ? [main.id] : []),
  ];
  return {
    id: sources.at(-1) ?? null,
    sources,
    durations: { ...initial.durations, ...main.durations },
  };
}
function readTimingData(
  input: unknown,
  context: { repository: string; workflow: string; now: number },
  identity: string,
): { id: string | null; durations: Record<string, number> } {
  const empty = { id: null, durations: {} };
  if (!isTimingData(input)) {
    return empty;
  }
  const h = input;
  const epoch = (() => {
    try {
      return Temporal.Instant.from(h.createdAt).epochMilliseconds;
    } catch {
      return Number.NaN;
    }
  })();
  const age = context.now - epoch;
  if (
    h.repository !== context.repository ||
    h.workflow !== context.workflow ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 30 * 86_400_000
  ) {
    return empty;
  }
  const groups = new Map<string, number[]>();
  for (const sample of h.samples) {
    const sampledAt = (() => {
      try {
        return Temporal.Instant.from(sample.sampledAt ?? h.createdAt).epochMilliseconds;
      } catch {
        return Number.NaN;
      }
    })();
    const sampleAge = context.now - sampledAt;
    if (!Number.isFinite(sampleAge) || sampleAge < 0 || sampleAge > 30 * 86_400_000) {
      continue;
    }
    if (sample.identity === identity) {
      const values = groups.get(sample.id) ?? [];
      values.push(sample.durationMs);
      groups.set(sample.id, values);
    }
  }
  return {
    id: h.id,
    durations: Object.fromEntries(
      [...groups].map(([id, values]) => {
        const sorted = values.slice(-10).toSorted((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return [id, sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2];
      }),
    ),
  };
}

export function mergeHistory(previous: unknown, current: History): History {
  const now = Temporal.Instant.from(current.createdAt).epochMilliseconds;
  const groups = new Map<string, Sample[]>();
  const trusted =
    readHistory(
      previous,
      { repository: current.repository, workflow: current.workflow, now },
      current.samples[0]?.identity ?? '',
    ).id !== null;
  const old = trusted && isHistory(previous) ? previous : null;
  const samples = [
    ...(old
      ? old.samples.map((sample) => ({
          id: sample.id,
          identity: sample.identity,
          durationMs: sample.durationMs,
          sampledAt: sample.sampledAt ?? old.createdAt,
        }))
      : []),
    ...current.samples.map((sample) => ({
      id: sample.id,
      identity: sample.identity,
      durationMs: sample.durationMs,
      sampledAt: current.createdAt,
    })),
  ];
  for (const sample of samples) {
    const epoch = (() => {
      try {
        return Temporal.Instant.from(sample.sampledAt).epochMilliseconds;
      } catch {
        return Number.NaN;
      }
    })();
    if (!Number.isFinite(epoch) || epoch > now || now - epoch > 30 * 86_400_000) {
      continue;
    }
    const key = JSON.stringify([sample.id, sample.identity]);
    const values = groups.get(key) ?? [];
    values.push(sample);
    groups.set(key, values.slice(-10));
  }
  return { ...current, samples: [...groups.values()].flat() };
}
