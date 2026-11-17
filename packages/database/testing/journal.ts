type Journal = Record<string, unknown> & { entries: (Record<string, unknown> & { tag: string })[] };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isJournal(value: unknown): value is Journal {
  return (
    isRecord(value) &&
    Array.isArray(value.entries) &&
    value.entries.every((entry: unknown) => isRecord(entry) && typeof entry.tag === 'string')
  );
}
export function parseJournal(text: string): Journal {
  const value: unknown = JSON.parse(text);
  if (!isJournal(value)) {
    throw new TypeError('migration履歴の形式が不正です。');
  }
  return value;
}
