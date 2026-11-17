import { parse, object, readTarget } from './schema.ts';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import type { SourceCoverageData } from '@vitest/istanbul-lib-instrument';
import type { CoverageTarget } from './merge.ts';

type CounterEvent =
  | { type: 'start'; pid: number }
  | { type: 'module'; file: CoverageTarget }
  | {
      type: 'count';
      path: string;
      kind: 's' | 'f' | 'b';
      id: string;
      index: number;
      value: number;
    };

/** カウンターの変更を実際の文実行より前に同期追記し、SIGKILLでも失わない。 */
export function createCounterJournal(path: string, targets: readonly CoverageTarget[]) {
  writeFileSync(path, `${JSON.stringify({ type: 'start', pid: process.pid })}\n`);
  const append = (event: CounterEvent) => {
    appendFileSync(path, `${JSON.stringify(event)}\n`);
  };
  const inventory = new Map(targets.map((target) => [target.path, target]));
  return new Proxy<Record<string, SourceCoverageData>>(
    {},
    {
      set(data, key, coverage: SourceCoverageData) {
        const name = String(key);
        const target = inventory.get(name);
        if (!target) {
          throw new Error(`台帳にない計測対象: ${name}`);
        }
        append({ type: 'module', file: { ...target, coverage } });
        for (const kind of ['s', 'f'] as const) {
          coverage[kind] = new Proxy(coverage[kind], {
            set(counts, id, value: number) {
              append({ type: 'count', path: name, kind, id: String(id), index: 0, value });
              return Reflect.set(counts, id, value);
            },
          });
        }
        for (const [id, counts] of Object.entries(coverage.b)) {
          coverage.b[id] = new Proxy(counts, {
            set(values, index, value: number) {
              append({ type: 'count', path: name, kind: 'b', id, index: Number(index), value });
              return Reflect.set(values, index, value);
            },
          });
        }
        return Reflect.set(data, key, coverage);
      },
    },
  );
}

export function replayCounterJournal(path: string): CoverageTarget[] {
  const events: CounterEvent[] = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => readEvent(parse(line)));
  const files = new Map<string, CoverageTarget>();
  for (const event of events) {
    if (event.type === 'module') {
      files.set(event.file.path, event.file);
    } else if (event.type === 'count') {
      const file = files.get(event.path);
      if (!file) {
        throw new Error('journalの対象記録がありません。');
      }
      const { coverage } = file;
      if (event.kind === 'b') {
        coverage.b[event.id][event.index] = event.value;
      } else {
        coverage[event.kind][event.id] = event.value;
      }
    }
  }
  return [...files.values()];
}

export function counterJournalOwnerIsRunning(path: string): boolean {
  const header = readEvent(parse(readFileSync(path, 'utf8').split('\n')[0]));
  if (header.type !== 'start' || !Number.isSafeInteger(header.pid) || header.pid <= 0) {
    throw new Error('計測journalの開始記録が不正です');
  }
  try {
    process.kill(header.pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function readEvent(value: unknown): CounterEvent {
  if (!object(value)) {
    throw new Error('計測journalが不正です。');
  }
  if (
    value.type === 'start' &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0
  ) {
    return { type: 'start', pid: value.pid };
  }
  if (value.type === 'module') {
    return { type: 'module', file: readTarget(value.file) };
  }
  if (
    value.type === 'count' &&
    typeof value.path === 'string' &&
    (value.kind === 's' || value.kind === 'f' || value.kind === 'b') &&
    typeof value.id === 'string' &&
    typeof value.index === 'number' &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    typeof value.value === 'number' &&
    Number.isSafeInteger(value.value) &&
    value.value >= 0
  ) {
    return {
      type: 'count',
      path: value.path,
      kind: value.kind,
      id: value.id,
      index: value.index,
      value: value.value,
    };
  }
  if (value.type === 'start') {
    throw new Error('計測journalの開始記録が不正です');
  }
  throw new Error('計測journalが不正です。');
}
