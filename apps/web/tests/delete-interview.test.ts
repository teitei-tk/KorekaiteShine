import { expect, test, vi } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import {
  interviews,
  evaluationInputs,
  transcriptFragments,
  playbackReceipts,
} from '@korekaite/database/interviews';
import {
  jobs,
  jobOutbox,
  executionSlots,
  jobAttempts,
  deletedJobs,
} from '@korekaite/database/jobs';
import { deleteInterviewRequest } from '../src/server/delete-interview';
import { createInterview } from '../src/server/repositories/interviews';

test('本人が評価中の面接を削除すると原文・実行履歴を消し、再送と遅延作成で復活しない', async () => {
  const database = createTestDatabase();
  const material = {
    interviewId: 'one',
    materialHash: 'hash',
    themeTitle: '構成',
    themeHeading: '本文',
    themeExcerpt: '架空の経験',
    background: '',
    activeMs: 5,
  };
  const request = new Request('http://localhost/api/interviews/one', { method: 'DELETE' });
  const discard = vi.fn(async () => {});
  const deps = { db: database.db, actor: () => 'actor', now: () => 10, discard };
  try {
    await database.db
      .insert(interviews)
      .values({ ...material, actorId: 'actor', status: 'ended', createdAt: 0, updatedAt: 5 });
    await database.db.insert(jobs).values({
      jobId: 'job',
      actorId: 'actor',
      purpose: 'evaluation',
      status: 'running',
      acceptedAt: 5,
      updatedAt: 6,
      attemptCount: 1,
    });
    await database.db.insert(evaluationInputs).values({
      jobId: 'job',
      interviewId: 'one',
      kind: 'initial',
      lastSequence: 1,
      inputJson: {
        schemaVersion: 1,
        interview: material,
        fragments: [],
        playback: [],
        transcriptIncomplete: false,
        evaluation: {
          model: 'mock',
          promptVersion: 'v1',
          rubricVersion: 'v1',
          instructions: '架空',
          rubric: '架空',
        },
      },
      model: 'mock',
      promptVersion: 'v1',
      rubricVersion: 'v1',
      createdAt: 5,
    });
    await database.db.insert(transcriptFragments).values({
      fragmentId: 'f1',
      interviewId: 'one',
      sequence: 1,
      generation: 1,
      sourceEventId: 'e1',
      speaker: 'user',
      content: '架空の原文',
      receivedAt: 3,
    });
    await database.db
      .insert(playbackReceipts)
      .values({ interviewId: 'one', generation: 1, audioOffsetMs: 4, receivedAt: 4 });
    await database.db.insert(jobAttempts).values({ jobId: 'job', attemptNumber: 1, startedAt: 6 });
    await database.db.insert(jobOutbox).values({
      id: 'notify',
      jobId: 'job',
      purpose: 'evaluation',
      operation: 'notify',
      scheduledAt: 5,
    });
    await database.db.insert(executionSlots).values({
      actorId: 'actor',
      jobId: 'job',
      generation: 1,
      ownerToken: 'worker',
      leaseUntil: 100,
    });
    expect(
      (await deleteInterviewRequest(request, 'one', { ...deps, actor: () => 'other' })).status,
    ).toBe(404);
    expect(discard).not.toHaveBeenCalled();
    expect((await deleteInterviewRequest(request, '../one', deps)).status).toBe(400);
    expect((await deleteInterviewRequest(request, 'one', deps)).status).toBe(204);
    expect((await deleteInterviewRequest(request, 'one', deps)).status).toBe(204);
    for (const table of [
      interviews,
      jobs,
      evaluationInputs,
      transcriptFragments,
      playbackReceipts,
      jobAttempts,
      jobOutbox,
      executionSlots,
    ]) {
      expect(await database.db.select().from(table)).toHaveLength(0);
    }
    expect(await database.db.select().from(deletedJobs)).toMatchObject([{ jobId: 'job' }]);
    expect(await createInterview(database.db, { ...material, actorId: 'actor' }, 12)).toBeNull();
    expect(discard).toHaveBeenCalledWith('actor', 'one');
  } finally {
    database.close();
  }
});
