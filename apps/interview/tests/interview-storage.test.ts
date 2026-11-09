import { expect, test, vi } from 'vitest';
import { interviews } from '@korekaite/database';
import { createTestDatabase } from '../../../packages/database/testing/sqlite.ts';
import {
  appendTranscript,
  markTranscriptIncomplete,
  loadInterview,
  saveInterviewState,
  recordPlayback,
} from '../src/server/repositories/interviews.ts';
import { finishInterview } from '../src/server/repositories/finish-interview.ts';

async function setup() {
  const database = createTestDatabase();
  await database.db.insert(interviews).values({
    interviewId: 'interview',
    actorId: 'actor',
    materialHash: 'hash',
    themeTitle: '構成',
    themeHeading: '判断',
    themeExcerpt: '架空の経験',
    background: '',
    status: 'active',
    generation: 1,
    streamGeneration: 1,
    activeSince: 0,
    deadline: 1200000,
    createdAt: 0,
    updatedAt: 0,
  });
  return database;
}

test('原文を順序付きで追記し、再送では上書きせず、終了待ちの最後の断片を保存する', async () => {
  const database = await setup();
  try {
    const fragment = {
      interviewId: 'interview',
      fragmentId: 'fragment-1',
      generation: 1,
      sourceEventId: 'event-1',
      speaker: 'user' as const,
      content: '制約を比較しました。',
      receivedAt: 100,
    };
    const first = await appendTranscript(database.db, 'actor', fragment);
    expect(first).toMatchObject({ sequence: 1, content: fragment.content });
    expect(await appendTranscript(database.db, 'actor', fragment)).toEqual(first);
    await expect(
      appendTranscript(database.db, 'actor', { ...fragment, content: '変更された原文' }),
    ).rejects.toThrow();
    expect(await appendTranscript(database.db, 'other', fragment)).toBeNull();
    const row = (await loadInterview(database.db, 'actor', 'interview'))!;
    expect(row.revision).toBe(1);
    const ending = {
      ...row,
      status: 'ending' as const,
      generation: 2,
      activeMs: 200,
      activeSince: null,
      deadline: null,
      updatedAt: 200,
    };
    expect(await saveInterviewState(database.db, 'actor', ending, row.revision)).toMatchObject({
      revision: 2,
    });
    expect(await saveInterviewState(database.db, 'actor', ending, row.revision)).toBeNull();
    const tail = {
      ...fragment,
      fragmentId: 'fragment-2',
      sourceEventId: 'event-2',
      content: '以上です。',
      receivedAt: 201,
    };
    expect(await appendTranscript(database.db, 'actor', tail)).toMatchObject({ sequence: 2 });
    expect(
      await saveInterviewState(
        database.db,
        'actor',
        { ...ending, streamGeneration: null, updatedAt: 202 },
        3,
      ),
    ).toMatchObject({ revision: 4 });
    expect(
      await appendTranscript(database.db, 'actor', {
        ...tail,
        sourceEventId: 'late',
        fragmentId: 'late',
      }),
    ).toBeNull();
  } finally {
    database.close();
  }
});

test('終了保存直前に会話が変わったら古い入力を固定せず、読取から再試行する', async () => {
  const database = await setup();
  try {
    await database.db.update(interviews).set({ status: 'ending' });
    const batch = database.db.batch.bind(database.db);
    const spy = vi.spyOn(database.db, 'batch').mockImplementationOnce(async (statements) => {
      await appendTranscript(database.db, 'actor', {
        interviewId: 'interview',
        fragmentId: 'tail',
        generation: 1,
        sourceEventId: 'tail',
        speaker: 'user',
        content: '最後の回答です。',
        receivedAt: 10,
      });
      return batch(statements);
    });
    const options = { jobId, evaluation, transcriptIncomplete: true };
    expect(await finishInterview(database.db, 'actor', 'interview', options, 10)).toBeNull();
    spy.mockRestore();
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM jobs').get()).toEqual({
      count: 0,
    });
    expect(await finishInterview(database.db, 'actor', 'interview', options, 11)).toBe(jobId);
    const row = database.sqlite.prepare('SELECT input_json FROM evaluation_inputs').get()!;
    expect(JSON.parse(String(row.input_json)).fragments).toMatchObject([
      { content: '最後の回答です。' },
    ]);
  } finally {
    database.close();
  }
});

test('再生確認は前進だけを保存し、古い接続からの確認で更新しない', async () => {
  const database = await setup();
  try {
    const input = { interviewId: 'interview', generation: 1, audioOffsetMs: 1000, receivedAt: 10 };
    expect(await recordPlayback(database.db, 'actor', input)).toBe(true);
    expect(
      await recordPlayback(database.db, 'actor', { ...input, audioOffsetMs: 2000, receivedAt: 20 }),
    ).toBe(true);
    expect(await recordPlayback(database.db, 'actor', input)).toBe(true);
    expect(await recordPlayback(database.db, 'actor', { ...input, generation: 0 })).toBe(false);
    expect(await recordPlayback(database.db, 'other', input)).toBe(false);
    expect(
      database.sqlite.prepare('SELECT audio_offset_ms, received_at FROM playback_receipts').all(),
    ).toEqual([{ audio_offset_ms: 2000, received_at: 20 }]);
    expect(await loadInterview(database.db, 'actor', 'interview')).toMatchObject({ revision: 2 });
  } finally {
    database.close();
  }
});

test('終了保存の途中で失敗してもジョブや終了状態が残らず、再試行できる', async () => {
  const database = await setup();
  try {
    await database.db.update(interviews).set({ status: 'ending' });
    database.sqlite.exec(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON job_outbox BEGIN SELECT RAISE(ABORT, 'simulated failure'); END",
    );
    const options = { jobId, evaluation, transcriptIncomplete: true };
    await expect(finishInterview(database.db, 'actor', 'interview', options, 10)).rejects.toThrow();
    for (const table of ['jobs', 'evaluation_inputs', 'job_outbox']) {
      expect(database.sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
    expect(await loadInterview(database.db, 'actor', 'interview')).toMatchObject({
      status: 'ending',
      revision: 0,
    });
    database.sqlite.exec('DROP TRIGGER fail_outbox');
    expect(await finishInterview(database.db, 'actor', 'interview', options, 11)).toBe(jobId);
    const row = database.sqlite.prepare('SELECT input_json FROM evaluation_inputs').get()!;
    expect(JSON.parse(String(row.input_json)).transcriptIncomplete).toBe(true);
  } finally {
    database.close();
  }
});

test('同時に届いた同じ終了要求はどちらも同じ初回ジョブを返す', async () => {
  const database = await setup();
  try {
    await database.db.update(interviews).set({ status: 'ending', streamGeneration: null });
    const options = { jobId, evaluation, transcriptIncomplete: false };
    expect(
      await Promise.all([
        finishInterview(database.db, 'actor', 'interview', options, 10),
        finishInterview(database.db, 'actor', 'interview', options, 10),
      ]),
    ).toEqual([jobId, jobId]);
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM jobs').get()).toEqual({
      count: 1,
    });
  } finally {
    database.close();
  }
});

const evaluation = {
  model: 'test-model',
  promptVersion: 'v1',
  rubricVersion: 'v1',
  instructions: '発言に基づいて評価する。',
  rubric: '架空の評価基準',
};
const jobId = '00000000-0000-4000-8000-000000000001';

test('終了時の会話・評価入力・ジョブ・通知を固定し、終了再送で同じジョブを返す', async () => {
  const database = await setup();
  try {
    await appendTranscript(database.db, 'actor', {
      interviewId: 'interview',
      fragmentId: 'f1',
      generation: 1,
      sourceEventId: 'e1',
      speaker: 'user',
      content: '比較して決めました。',
      receivedAt: 10,
    });
    const active = (await loadInterview(database.db, 'actor', 'interview'))!;
    const ending = {
      ...active,
      status: 'ending' as const,
      generation: 2,
      activeMs: 20,
      activeSince: null,
      deadline: null,
      updatedAt: 20,
    };
    await saveInterviewState(database.db, 'actor', ending, active.revision);
    const options = {
      jobId,
      evaluation: { ...evaluation, apiKey: 'fixture-secret' },
      transcriptIncomplete: false,
    };
    // 上流終了を確認するまでは完全な会話として固定しない。
    expect(await finishInterview(database.db, 'actor', 'interview', options, 21)).toBeNull();
    await saveInterviewState(
      database.db,
      'actor',
      { ...ending, streamGeneration: null, updatedAt: 22 },
      2,
    );
    expect(await finishInterview(database.db, 'actor', 'interview', options, 23)).toBe(jobId);
    expect(
      await finishInterview(
        database.db,
        'actor',
        'interview',
        {
          ...options,
          jobId: '00000000-0000-4000-8000-000000000002',
        },
        24,
      ),
    ).toBe(jobId);
    expect(await finishInterview(database.db, 'other', 'interview', options, 24)).toBeNull();
    const saved = database.sqlite
      .prepare('SELECT input_json, last_sequence FROM evaluation_inputs')
      .get()!;
    expect(saved.last_sequence).toBe(1);
    expect(String(saved.input_json)).not.toContain('fixture-secret');
    expect(JSON.parse(String(saved.input_json))).toMatchObject({
      schemaVersion: 1,
      evaluation,
      transcriptIncomplete: false,
      interview: { themeExcerpt: '架空の経験', activeMs: 20 },
      fragments: [{ fragmentId: 'f1', sequence: 1, content: '比較して決めました。' }],
      playback: [],
    });
    expect(database.sqlite.prepare('SELECT job_id, status, purpose FROM jobs').all()).toEqual([
      { job_id: jobId, status: 'pending', purpose: 'evaluation' },
    ]);
    expect(database.sqlite.prepare('SELECT job_id, operation FROM job_outbox').all()).toEqual([
      { job_id: jobId, operation: 'notify' },
    ]);
    expect(await loadInterview(database.db, 'actor', 'interview')).toMatchObject({
      status: 'ended',
      endedAt: 23,
    });
    expect(
      await appendTranscript(database.db, 'actor', {
        interviewId: 'interview',
        fragmentId: 'late',
        generation: 1,
        sourceEventId: 'late',
        speaker: 'user',
        content: '後からの補足',
        receivedAt: 25,
      }),
    ).toBeNull();
  } finally {
    database.close();
  }
});

test('接続欠落の記録は終了時に引き継ぎ、呼出側のfalseで消さない', async () => {
  const database = await setup();
  try {
    database.sqlite.exec(
      "UPDATE interviews SET status = 'ending', stream_generation = NULL, transcript_incomplete = 1",
    );
    await finishInterview(
      database.db,
      'actor',
      'interview',
      {
        jobId,
        evaluation,
        transcriptIncomplete: false,
      },
      10,
    );
    const row = database.sqlite.prepare('SELECT input_json FROM evaluation_inputs').get()!;
    expect(JSON.parse(String(row.input_json)).transcriptIncomplete).toBe(true);
  } finally {
    database.close();
  }
});

test('同時到着した原文と再生確認を一度だけ保存し、旧世代の新規確認を拒否する', async () => {
  const database = await setup();
  try {
    const fragment = {
      interviewId: 'interview',
      generation: 1,
      fragmentId: 'f',
      sourceEventId: 's',
      speaker: 'assistant' as const,
      content: '質問',
      receivedAt: 2,
    };
    const results = await Promise.all([
      appendTranscript(database.db, 'actor', fragment),
      appendTranscript(database.db, 'actor', fragment),
    ]);
    expect(results[0]).toMatchObject({ sequence: 1 });
    expect(results[1]).toEqual(results[0]);
    const input = { interviewId: 'interview', generation: 1, audioOffsetMs: 2, receivedAt: 3 };
    expect(
      await Promise.all([
        recordPlayback(database.db, 'actor', input),
        recordPlayback(database.db, 'actor', input),
      ]),
    ).toEqual([true, true]);
    expect(await recordPlayback(database.db, 'actor', { ...input, generation: 10 })).toBe(false);
    const state = (await loadInterview(database.db, 'actor', 'interview'))!;
    await expect(
      saveInterviewState(database.db, 'actor', { ...state, status: 'ended' }, state.revision),
    ).rejects.toThrow('一体');
    for (const [actor, now] of [
      ['actor', -1],
      ['missing', 5],
    ] as const) {
      await expect(
        markTranscriptIncomplete(database.db, actor, 'interview', now),
      ).rejects.toThrow();
    }
    await database.db.update(interviews).set({ status: 'ending', streamGeneration: null });
    await expect(
      finishInterview(
        database.db,
        'actor',
        'interview',
        { evaluation, jobId: 'invalid', transcriptIncomplete: false },
        4,
      ),
    ).rejects.toThrow('設定');
  } finally {
    database.close();
  }
});
