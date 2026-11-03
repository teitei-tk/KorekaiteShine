import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runWithEvidence } from '../src/evidence.ts';

test('後処理が失敗しても全処理を試み、例外の秘密値を含めず失敗記録を残す', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'integration-evidence-'));
  const resultPath = join(directory, 'results.json');
  const cleaned: string[] = [];
  try {
    await expect(
      runWithEvidence(
        { resultPath, metadata: { environment: 'test', case: 'cleanup' } },
        async (evidence) => {
          evidence.cleanup(async () => {
            cleaned.push('first');
          });
          evidence.cleanup(async () => {
            cleaned.push('second');
            throw new Error('secret-token-sentinel');
          });
          evidence.observe({ received: 1 });
        },
      ),
    ).rejects.toThrow('CLEANUP_FAILED');
    expect(cleaned).toEqual(['second', 'first']);
    const serialized = await readFile(resultPath, 'utf8');
    expect(serialized).not.toContain('secret-token-sentinel');
    expect(JSON.parse(serialized)).toMatchObject({
      environment: 'test',
      case: 'cleanup',
      actual: { received: 1 },
      exitCode: 1,
      failureCode: 'CLEANUP_FAILED',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
