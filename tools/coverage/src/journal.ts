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
  writeFileSync(path, JSON.stringify({ type: 'start', pid: process.pid }) + '\n');
  const append = (event: CounterEvent) => appendFileSync(path, JSON.stringify(event) + '\n');
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
    .map((line) => JSON.parse(line));
  const files = new Map<string, CoverageTarget>();
  for (const event of events) {
    if (event.type === 'module') {
      files.set(event.file.path, event.file);
    } else if (event.type === 'count') {
      const coverage = files.get(event.path)!.coverage;
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
  const header: CounterEvent = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]);
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
