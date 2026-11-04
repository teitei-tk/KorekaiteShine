import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Observation = Record<string, JsonValue>;

interface EvidenceContext {
  /** 秘密値や入力本文を除いた実測値だけを渡す。 */
  observe(values: Observation): void;
  /** 登録と逆順で実行し、一つの失敗でも残りの後処理を省略しない。 */
  cleanup(action: (passed: boolean) => Promise<void>): void;
}

export async function runWithEvidence(
  input: { resultPath: string; metadata: Observation },
  run: (evidence: EvidenceContext) => Promise<void>,
): Promise<void> {
  const started = performance.now();
  const actual: Observation = {};
  const cleanups: ((passed: boolean) => Promise<void>)[] = [];
  const report = {
    ...input.metadata,
    startedAt: Temporal.Now.instant().toString({ fractionalSecondDigits: 3 }),
    finishedAt: null as string | null,
    durationMs: null as number | null,
    actual,
    exitCode: null as 0 | 1 | null,
    failureCode: null as 'CASE_FAILED' | 'CLEANUP_FAILED' | null,
  };
  await mkdir(dirname(input.resultPath), { recursive: true });
  await writeFile(input.resultPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  let failure: Error | undefined;
  try {
    await run({
      observe: (values) => {
        Object.assign(actual, values);
      },
      cleanup: (action) => {
        cleanups.push(action);
      },
    });
  } catch (error) {
    report.failureCode = 'CASE_FAILED';
    failure = error instanceof Error ? error : new Error('CASE_FAILED');
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup(!failure);
      } catch {
        report.failureCode ??= 'CLEANUP_FAILED';
        failure ??= new Error('CLEANUP_FAILED');
      }
    }
    report.exitCode = failure ? 1 : 0;
    report.finishedAt = Temporal.Now.instant().toString({ fractionalSecondDigits: 3 });
    report.durationMs = Math.round(performance.now() - started);
    await writeFile(input.resultPath, JSON.stringify(report, null, 2));
  }
  if (failure) {
    throw failure;
  }
}
