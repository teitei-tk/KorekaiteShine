import { snapshot } from './fixtures/evaluation.ts';
import { createJobEvaluator } from '../src/server/evaluate-job';
import { interviews, evaluationInputs } from '@korekaite/database/interviews';
import { jobs } from '@korekaite/database/jobs';
import { expect, test, vi } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { reserveEvaluation } from '../src/server/repositories/evaluation-usage';

test('新規評価を一日10ジョブに制限し、日付をまたぐ自動再試行は元の枠を使う', async () => {
  const database = createTestDatabase();
  try {
    const now = 1794063599000;
    const reserve = (jobId: string, actorId = 'actor', at = now) =>
      reserveEvaluation(database.db, { jobId, actorId, now: at });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => reserve(`job-${index}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await reserve('job-0')).toBe(true);
    expect(await reserve('job-0', 'other')).toBe(false);
    expect(await reserve('job-0', 'actor', now + 1000)).toBe(true);
    const tomorrow = await Promise.all(
      Array.from({ length: 11 }, (_, index) => reserve(`tomorrow-${index}`, 'actor', now + 1000)),
    );
    expect(tomorrow.filter(Boolean)).toHaveLength(10);
  } finally {
    database.close();
  }
});

test('枠がない新規ジョブではAIを呼ばず、既存予約の再試行と無回答は処理する', async () => {
  const database = createTestDatabase();
  const now = 1000;
  try {
    for (let index = 0; index < 10; index += 1) {
      expect(
        await reserveEvaluation(database.db, { jobId: `job-${index}`, actorId: 'actor', now }),
      ).toBe(true);
    }
    const material = {
      interviewId: 'one',
      materialHash: 'hash',
      themeTitle: '構成',
      themeHeading: '判断',
      themeExcerpt: '架空の経験',
      background: '',
      activeMs: 1,
    };
    await database.db.insert(interviews).values({
      ...material,
      actorId: 'actor',
      status: 'ended',
      createdAt: 0,
      updatedAt: 1,
      endedAt: 1,
    });
    for (const jobId of ['job-0', 'new', 'empty']) {
      await database.db.insert(jobs).values({
        jobId,
        actorId: 'actor',
        purpose: 'evaluation',
        status: 'running',
        attemptCount: 1,
        acceptedAt: 0,
        updatedAt: 1,
      });
      await database.db.insert(evaluationInputs).values({
        jobId,
        interviewId: 'one',
        kind: 'manual',
        lastSequence: 1,
        model: 'fixture',
        promptVersion: 'v1',
        rubricVersion: 'v1',
        createdAt: 1,
        inputJson: {
          schemaVersion: 1,
          interview: material,
          fragments:
            jobId === 'empty'
              ? []
              : [
                  {
                    interviewId: 'one',
                    fragmentId: 'f1',
                    sourceEventId: 'event',
                    sequence: 1,
                    generation: 1,
                    speaker: 'user',
                    content: '架空の回答',
                    sourceStartMs: null,
                    sourceEndMs: null,
                    receivedAt: 1,
                  },
                ],
          playback: [],
          transcriptIncomplete: false,
          evaluation: {
            model: 'fixture',
            promptVersion: 'v1',
            rubricVersion: 'v1',
            instructions: '架空の指示',
            rubric: '架空の基準',
          },
        },
      });
    }
    const generate = vi.fn(async () => {
      throw new Error('モックAI');
    });
    const evaluate = createJobEvaluator(database.db, generate, () => now);
    const signal = new AbortController().signal;
    expect(await evaluate('new', 1, signal)).toEqual({
      ok: false,
      error: { code: 'EVALUATION_USAGE_LIMIT', retryable: false },
    });
    expect(generate).not.toHaveBeenCalled();
    expect(await evaluate('empty', 1, signal)).toMatchObject({
      ok: true,
      value: { summary: '評価対象の回答なし' },
    });
    expect(generate).not.toHaveBeenCalled();
    await evaluate('job-0', 1, signal);
    expect(generate).toHaveBeenCalledTimes(1);
  } finally {
    database.close();
  }
});

test('評価枠を確保する間に中断したジョブではAIに送信しない', async () => {
  const database = createTestDatabase();
  const controller = new AbortController();
  try {
    const material = snapshot.interview;
    await database.db
      .insert(interviews)
      .values({ ...material, actorId: 'actor', status: 'ended', createdAt: 0, updatedAt: 1 });
    await database.db.insert(jobs).values({
      jobId: 'job',
      actorId: 'actor',
      purpose: 'evaluation',
      status: 'running',
      attemptCount: 1,
      acceptedAt: 0,
      updatedAt: 1,
    });
    await database.db.insert(evaluationInputs).values({
      jobId: 'job',
      interviewId: material.interviewId,
      kind: 'manual',
      lastSequence: 1,
      model: 'fixture',
      promptVersion: 'v1',
      rubricVersion: 'v1',
      createdAt: 1,
      inputJson: snapshot,
    });
    const generate = vi.fn(async () => null);
    const evaluate = createJobEvaluator(database.db, generate, () => {
      controller.abort();
      return 1000;
    });
    expect(await evaluate('job', 1, controller.signal)).toMatchObject({
      error: { code: 'AI_ABORTED' },
    });
    expect(generate).not.toHaveBeenCalled();
    const liveClock = createJobEvaluator(database.db, generate);
    await liveClock('job', 1, new AbortController().signal);
    expect(generate).toHaveBeenCalledOnce();
  } finally {
    database.close();
  }
});
