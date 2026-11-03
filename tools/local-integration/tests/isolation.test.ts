import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { runIsolationIntegration } from '../src/isolation.ts';

test('開発DBを保持しながら並列test二環境のD1・DO・Queue・出力を隔離する', async () => {
  const developmentFiles = ['web/vite.config.ts', 'runtime.log', 'database/.void/local-d1.json'];
  const modifiedAt = () =>
    Promise.all(
      developmentFiles.map(async (path) => {
        try {
          return (
            await stat(
              fileURLToPath(
                new URL(`../../../.local/development/artifacts/${path}`, import.meta.url),
              ),
            )
          ).mtimeMs;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        }
      }),
    );
  const developmentBefore = await modifiedAt();
  const resultPath = await runIsolationIntegration();
  expect(await modifiedAt(), '統合検査から開発ランタイムの起動・準備を行ってはいけません').toEqual(
    developmentBefore,
  );
  const report = JSON.parse(await readFile(resultPath, 'utf8'));
  expect(report).toMatchObject({
    environment: 'test',
    case: 'parallel-isolation',
    exitCode: 0,
    actual: {
      developmentBefore: { sentinelCount: 1, sentinelMatches: true },
      secondJobBeforeSend: { status: 'pending', attemptCount: 0 },
      secondDoBeforeWrite: null,
      doMarkersIsolated: true,
      outputMarkersIsolated: true,
    },
  });
  expect(report.actual.developmentAfter).toEqual(report.actual.developmentBefore);
  expect(report.actual.testEnvironments).toHaveLength(2);
  expect(report.actual.testEnvironments.map((entry: { slot: number }) => entry.slot)).toEqual([
    0, 1,
  ]);
  expect(
    report.actual.testEnvironments.every(
      (entry: { status: string; attemptCount: number; queueMatches: boolean }) =>
        entry.status === 'completed' && entry.attemptCount === 1 && entry.queueMatches,
    ),
  ).toBe(true);
  expect(
    new Set(report.actual.testEnvironments.map((entry: { queue: string }) => entry.queue)).size,
  ).toBe(2);
}, 180_000);
