export function assignTests(
  tests: readonly string[],
  durations: Readonly<Record<string, number>>,
  count: number,
): string[][] {
  if (!Number.isInteger(count) || count < 1 || new Set(tests).size !== tests.length) {
    throw new Error('割当入力が不正です。');
  }
  const known = Object.values(durations)
    .filter((n) => Number.isFinite(n) && n > 0)
    .toSorted((a, b) => a - b);
  const fallback = known[Math.max(0, Math.ceil(known.length * 0.75) - 1)] ?? 1;
  const weight = (id: string) =>
    Number.isFinite(durations[id]) && durations[id] > 0 ? durations[id] : fallback;
  const bins = Array.from({ length: Math.min(count, tests.length) }, () => ({
    ids: [] as string[],
    weight: 0,
  }));
  for (const id of [...tests].toSorted((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const [bin] = bins.toSorted((a, b) => a.weight - b.weight);

    bin.ids.push(id);
    bin.weight += weight(id);
  }
  return bins.map((bin) => bin.ids);
}
