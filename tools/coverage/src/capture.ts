import { replayCounterJournal, counterJournalOwnerIsRunning } from './journal.ts';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SourceCoverageData } from '@vitest/istanbul-lib-instrument';
import type { CoverageRun, Measurement } from './merge.ts';

/** 開始記録を先に残し、強制終了を正常な空の収集と区別する。 */
export function startCapture(
  run: CoverageRun,
  suite: string,
  directory: string,
  captureId: string = randomUUID(),
) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${captureId}.json`);
  const record: Measurement = {
    formatVersion: 1,
    captureId,
    runId: run.runId,
    revision: run.revision,
    suite,
    status: 'incomplete',
    files: [],
  };
  const save = () => {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(record));
    renameSync(temporary, path);
  };
  appendFileSync(join(directory, 'starts.jsonl'), JSON.stringify(captureId) + '\n');
  save();
  return {
    path,
    finish(
      data: Record<string, SourceCoverageData>,
      status: 'complete' | 'failed',
      failure?: string,
    ) {
      const targets = new Set(run.targets.map((target) => target.path));
      for (const key of Object.keys(data)) {
        if (!targets.has(key)) {
          throw new Error(`台帳にない計測対象: ${key}`);
        }
      }
      record.files = run.targets
        .filter((target) => data[target.path])
        .map((target) => ({ ...target, coverage: data[target.path] }));
      record.status = status;
      record.failure = failure;
      save();
    },
  };
}

export function readCaptures(directory: string): Measurement[] {
  const ids: string[] = readFileSync(join(directory, 'starts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return ids.map((id) => {
    const path = join(directory, `${id}.json`);
    if (!existsSync(path)) {
      throw new Error(`収集片が欠落しています: ${id}`);
    }
    const record: Measurement = JSON.parse(readFileSync(path, 'utf8'));
    if (
      record.status === 'incomplete' &&
      existsSync(`${path}.events`) &&
      !counterJournalOwnerIsRunning(`${path}.events`)
    ) {
      record.files = replayCounterJournal(`${path}.events`);
      record.status = 'complete';
    }
    return record;
  });
}
