import { expect, test } from 'vitest';
import { interviews, transcriptFragments, evaluationInputs } from '@korekaite/database/interviews';
import { jobs, jobAttempts } from '@korekaite/database/jobs';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import { interviewDetailRequest } from '../src/server/interview-detail';

test('本人の原文と評価を返し、内部設定・別人の記録・壊れた評価を公開しない', async () => {
  const database = createTestDatabase();
  try {
    const material = {
      interviewId: 'one',
      materialHash: 'hash',
      themeTitle: '架空の判断',
      themeHeading: '背景',
      themeExcerpt: '架空の経験',
      background: '',
      activeMs: 1000,
    };
    await database.db.insert(interviews).values({
      ...material,
      actorId: 'actor',
      status: 'ended',
      createdAt: 0,
      updatedAt: 1000,
      endedAt: 1000,
    });
    await database.db.insert(transcriptFragments).values({
      fragmentId: 'f1',
      interviewId: 'one',
      sequence: 1,
      generation: 1,
      sourceEventId: 'private-event',
      speaker: 'user',
      content: '架空の回答',
      receivedAt: 500,
    });
    await database.db.insert(jobs).values({
      jobId: 'job',
      actorId: 'actor',
      purpose: 'evaluation',
      status: 'completed',
      attemptCount: 1,
      acceptedAt: 1000,
      updatedAt: 1000,
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
          model: 'test-model',
          promptVersion: 'v1',
          rubricVersion: 'v1',
          instructions: 'private-instructions',
          rubric: 'private-rubric',
        },
      },
      model: 'test-model',
      promptVersion: 'v1',
      rubricVersion: 'v1',
      createdAt: 1000,
    });
    const axis = { status: 'unconfirmed', score: null, reason: '未確認', evidence: [] };
    const result = {
      summary: '未確認の項目があります。',
      axes: { problem: axis, alternatives: axis, reasoning: axis, action: axis, learning: axis },
      strengths: [],
      gaps: [],
      unconfirmed: [],
      practiceQuestions: [],
      consistency: [],
    };
    await database.db.insert(jobAttempts).values({
      jobId: 'job',
      attemptNumber: 1,
      startedAt: 1000,
      finishedAt: 1000,
      resultJson: JSON.stringify(result),
    });
    const request = new Request('http://localhost/api/interviews/one');
    const deps = { db: database.db, actor: () => 'actor' };
    const response = await interviewDetailRequest(request, 'one', deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(body.audioRemainingMs).toBe(3600000);
    expect(body.transcripts).toEqual([
      {
        fragmentId: 'f1',
        sequence: 1,
        generation: 1,
        speaker: 'user',
        content: '架空の回答',
        sourceStartMs: null,
        sourceEndMs: null,
        receivedAt: 500,
      },
    ]);
    expect(body.evaluation.result).toEqual(result);
    expect(JSON.stringify(body)).not.toMatch(/private-|materialHash|actorId/);
    expect(
      (await interviewDetailRequest(request, 'one', { ...deps, actor: () => 'other' })).status,
    ).toBe(404);
    expect(
      (await interviewDetailRequest(request, 'one', { ...deps, actor: () => null })).status,
    ).toBe(403);
    expect((await interviewDetailRequest(request, '../one', deps)).status).toBe(400);
    await database.db.update(jobAttempts).set({ resultJson: '{"private":"bad"}' });
    expect((await interviewDetailRequest(request, 'one', deps)).status).toBe(503);
  } finally {
    database.close();
  }
});
