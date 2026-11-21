import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createExplorationSummary } from './evidence.ts';
import type { ExplorationEvidenceInput } from './evidence.ts';

/** 長時間探索のJSONLを一括で文字列化せず、UTF-8の行単位で集計する。 */
export async function summarizeRecording(input: ExplorationEvidenceInput & { path: string }) {
  const summary = createExplorationSummary(input);
  const stream = createReadStream(input.path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      summary.add(line);
    }
    return summary.finish();
  } finally {
    lines.close();
    stream.destroy();
  }
}
