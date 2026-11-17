import { parseObject, objectAt, objectArray, stringValue } from './helpers/config-json.ts';
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
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return null;
          }
          throw error;
        }
      }),
    );
  const developmentBefore = await modifiedAt();
  const resultPath = await runIsolationIntegration();
  expect(await modifiedAt(), '統合検査から開発ランタイムの起動・準備を行ってはいけません').toEqual(
    developmentBefore,
  );
  const report = parseObject(await readFile(resultPath, 'utf8'));
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
  expect(objectAt(report.actual).developmentAfter).toEqual(
    objectAt(report.actual).developmentBefore,
  );
  expect(objectAt(report.actual).testEnvironments).toHaveLength(2);
  expect(objectArray(objectAt(report.actual).testEnvironments).map((entry) => entry.slot)).toEqual([
    0, 1,
  ]);
  expect(
    objectArray(objectAt(report.actual).testEnvironments).every(
      (entry) =>
        entry.status === 'completed' && entry.attemptCount === 1 && entry.queueMatches === true,
    ),
  ).toBe(true);
  expect(
    new Set(
      objectArray(objectAt(report.actual).testEnvironments).map((entry) =>
        stringValue(entry.queue),
      ),
    ).size,
  ).toBe(2);
}, 180_000);
