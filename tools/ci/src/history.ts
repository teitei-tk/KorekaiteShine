/* eslint-disable typescript/no-restricted-types -- 履歴artifactはunknownとして受け、全フィールドを検証する。 */
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
function isHistory(value: unknown): value is History {
  return (
    isRecord(value) &&
    value.schema === 1 &&
    typeof value.id === 'string' &&
    typeof value.repository === 'string' &&
    typeof value.workflow === 'string' &&
    value.event === 'push' &&
    value.branch === 'main' &&
    value.conclusion === 'success' &&
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
export function readHistory(
  input: unknown,
  context: { repository: string; workflow: string; now: number },
  identity: string,
): { id: string | null; durations: Record<string, number> } {
  const empty = { id: null, durations: {} };
  if (!isHistory(input)) {
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
    ...(old?.samples ?? []).map((sample) => ({
      id: sample.id,
      identity: sample.identity,
      durationMs: sample.durationMs,
      sampledAt: sample.sampledAt ?? old?.createdAt,
    })),
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
        return Temporal.Instant.from(sample.sampledAt ?? '').epochMilliseconds;
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
