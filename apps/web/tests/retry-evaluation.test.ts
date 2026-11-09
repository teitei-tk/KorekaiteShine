import { expect, test } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { retryEvaluationRequest } from '../src/server/retry-evaluation';
import { interviews, evaluationInputs } from '@korekaite/database/interviews';
import { jobs, jobOutbox } from '@korekaite/database/jobs';
import { eq } from 'void/db';

test('失敗した本人の評価を同じ固定入力で一度だけ再受付し、ジョブと通知を保存する', async () => {
  const database = createTestDatabase();
  const parent = crypto.randomUUID();
  const material = {
    interviewId: 'one',
    materialHash: 'hash',
    themeTitle: '構成',
    themeHeading: '本文',
    themeExcerpt: '架空の材料',
    background: '',
    activeMs: 0,
  };
  const snapshot = {
    schemaVersion: 1 as const,
    interview: material,
    fragments: [],
    playback: [],
    transcriptIncomplete: false,
    evaluation: {
      model: 'original',
      promptVersion: 'v1',
      rubricVersion: 'r1',
      instructions: '当初の指示',
      rubric: '当初の基準',
    },
  };
  const request = () =>
    new Request('http://localhost/api/interviews/one/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ failedJobId: parent }),
    });
  const deps = {
    db: database.db,
    actor: () => 'actor',
    now: () => 1,
    newId: () => crypto.randomUUID(),
  };
  try {
    await database.db
      .insert(interviews)
      .values({ ...material, actorId: 'actor', status: 'ended', createdAt: 0, updatedAt: 1 });
    await database.db.insert(jobs).values({
      jobId: parent,
      actorId: 'actor',
      purpose: 'evaluation',
      status: 'running',
      acceptedAt: 0,
      updatedAt: 1,
    });
    await database.db.insert(evaluationInputs).values({
      jobId: parent,
      interviewId: 'one',
      kind: 'initial',
      lastSequence: 0,
      inputJson: snapshot,
      model: 'original',
      promptVersion: 'v1',
      rubricVersion: 'r1',
      createdAt: 1,
    });
    expect((await retryEvaluationRequest(request(), 'one', deps)).status).toBe(409);
    await database.db.update(jobs).set({ status: 'failed' }).where(eq(jobs.jobId, parent));
    expect(
      (await retryEvaluationRequest(request(), 'one', { ...deps, actor: () => 'other' })).status,
    ).toBe(404);
    database.sqlite.exec(
      "CREATE TRIGGER reject_retry_outbox BEFORE INSERT ON job_outbox BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    expect((await retryEvaluationRequest(request(), 'one', deps)).status).toBe(503);
    expect(await database.db.select().from(jobs)).toHaveLength(1);
    expect(await database.db.select().from(evaluationInputs)).toHaveLength(1);
    database.sqlite.exec('DROP TRIGGER reject_retry_outbox');
    database.sqlite.exec(
      'CREATE TRIGGER skip_retry BEFORE INSERT ON jobs BEGIN SELECT RAISE(IGNORE); END',
    );
    expect((await retryEvaluationRequest(request(), 'one', deps)).status).toBe(409);
    database.sqlite.exec('DROP TRIGGER skip_retry');
    const result = await Promise.all([
      retryEvaluationRequest(request(), 'one', deps),
      retryEvaluationRequest(request(), 'one', deps),
    ]);
    expect(result.map((r) => r.status)).toEqual([202, 202]);
    const [first, second] = await Promise.all(result.map((r) => r.json()));
    expect(first).toEqual(second);
    expect(first.jobId).not.toBe(parent);
    const [copy] = await database.db
      .select()
      .from(evaluationInputs)
      .where(eq(evaluationInputs.jobId, first.jobId));
    await database.db.insert(jobs).values({
      jobId: 'bad-id',
      actorId: 'actor',
      purpose: 'evaluation',
      status: 'pending',
      acceptedAt: 1,
      updatedAt: 1,
    });
    await database.db
      .update(evaluationInputs)
      .set({ jobId: 'bad-id' })
      .where(eq(evaluationInputs.jobId, first.jobId));
    expect((await retryEvaluationRequest(request(), 'one', deps)).status).toBe(503);
    expect(copy.inputJson).toEqual(snapshot);
    expect(copy.createdAt).toBeGreaterThan(1);
    expect(await database.db.select().from(jobOutbox)).toMatchObject([
      { jobId: first.jobId, operation: 'notify' },
    ]);
  } finally {
    database.close();
  }
});
