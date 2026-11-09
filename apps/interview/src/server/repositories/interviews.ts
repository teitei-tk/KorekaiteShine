import { closeAudioPeriod } from '@korekaite/database/audio-periods';
import { and, eq, lt, lte, ne, sql } from 'void/db';
import { interviews, transcriptFragments, playbackReceipts } from '@korekaite/database/interviews';
import type { createPrimaryDb } from '@korekaite/database/connection';
import type { InterviewState } from '../../domain/interview-state';

type Database = ReturnType<typeof createPrimaryDb>;
type Fragment = typeof transcriptFragments.$inferSelect;
type NewFragment = Omit<typeof transcriptFragments.$inferInsert, 'sequence'>;

export async function loadInterview(db: Database, actorId: string, interviewId: string) {
  const [row] = await db
    .select()
    .from(interviews)
    .where(and(eq(interviews.interviewId, interviewId), eq(interviews.actorId, actorId)));
  return row ?? null;
}

export async function saveInterviewState(
  db: Database,
  actorId: string,
  state: InterviewState,
  revision: number,
) {
  if (state.status === 'ended') {
    throw new Error('終了は評価入力と一体で保存してください。');
  }
  const guard = and(
    eq(interviews.interviewId, state.interviewId),
    eq(interviews.actorId, actorId),
    eq(interviews.revision, revision),
    ne(interviews.status, 'ended'),
    lte(interviews.updatedAt, state.updatedAt),
    lte(interviews.generation, state.generation),
    lte(interviews.activeMs, state.activeMs),
  );
  const update = db
    .update(interviews)
    .set({
      status: state.status,
      generation: state.generation,
      streamGeneration: state.streamGeneration,
      activeMs: state.activeMs,
      activeSince: state.activeSince,
      deadline: state.deadline,
      updatedAt: state.updatedAt,
      revision: revision + 1,
    })
    .where(guard)
    .returning();
  const [saved] =
    state.activeSince === null
      ? (await db.batch([closeAudioPeriod(db, guard, state.updatedAt), update]))[1]
      : await update;

  return saved ?? null;
}

function sameFragment(row: Fragment, input: NewFragment): Fragment {
  if (
    row.fragmentId !== input.fragmentId ||
    row.speaker !== input.speaker ||
    row.content !== input.content ||
    row.sourceStartMs !== (input.sourceStartMs ?? null) ||
    row.sourceEndMs !== (input.sourceEndMs ?? null)
  ) {
    throw new Error('同じ受信IDの原文は変更できません。');
  }
  return row;
}

export async function appendTranscript(
  db: Database,
  actorId: string,
  input: NewFragment,
): Promise<Fragment | null> {
  const interview = await loadInterview(db, actorId, input.interviewId);
  if (!interview) {
    return null;
  }
  const identity = and(
    eq(transcriptFragments.interviewId, input.interviewId),
    eq(transcriptFragments.generation, input.generation),
    eq(transcriptFragments.sourceEventId, input.sourceEventId),
  );
  const [existing] = await db.select().from(transcriptFragments).where(identity);
  if (existing) {
    return sameFragment(existing, input);
  }
  const eligible = and(
    eq(interviews.interviewId, input.interviewId),
    eq(interviews.actorId, actorId),
    eq(interviews.revision, interview.revision),
    eq(interviews.streamGeneration, input.generation),
    ne(interviews.status, 'ended'),
  );
  const [inserted] = await db.batch([
    db
      .insert(transcriptFragments)
      .select(
        db
          .select({
            fragmentId: sql<string>`${input.fragmentId}`.as('fragment_id'),
            interviewId: interviews.interviewId,
            sequence:
              sql<number>`(SELECT coalesce(max(sequence), 0) + 1 FROM transcript_fragments WHERE interview_id = ${input.interviewId})`.as(
                'sequence',
              ),
            generation: sql<number>`${input.generation}`.as('generation'),
            sourceEventId: sql<string>`${input.sourceEventId}`.as('source_event_id'),
            speaker: sql<Fragment['speaker']>`${input.speaker}`.as('speaker'),
            content: sql<string>`${input.content}`.as('content'),
            sourceStartMs: sql<number | null>`${input.sourceStartMs ?? null}`.as('source_start_ms'),
            sourceEndMs: sql<number | null>`${input.sourceEndMs ?? null}`.as('source_end_ms'),
            receivedAt: sql<number>`${input.receivedAt}`.as('received_at'),
          })
          .from(interviews)
          .where(eligible),
      )
      .onConflictDoNothing()
      .returning(),
    // D1 batch内の直前のINSERTが成功した場合だけrevisionを進める。
    db
      .update(interviews)
      .set({
        revision: interview.revision + 1,
        updatedAt: sql`max(${interviews.updatedAt}, ${input.receivedAt})`,
      })
      .where(and(eligible, sql`changes() = 1`)),
  ]);
  if (inserted[0]) {
    return inserted[0];
  }
  const [replayed] = await db.select().from(transcriptFragments).where(identity);
  return replayed ? sameFragment(replayed, input) : null;
}

export async function recordPlayback(
  db: Database,
  actorId: string,
  input: typeof playbackReceipts.$inferInsert,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(input.audioOffsetMs) ||
    input.audioOffsetMs < 0 ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1
  ) {
    return false;
  }
  const interview = await loadInterview(db, actorId, input.interviewId);
  if (!interview) {
    return false;
  }
  const identity = and(
    eq(playbackReceipts.interviewId, input.interviewId),
    eq(playbackReceipts.generation, input.generation),
  );
  const [existing] = await db.select().from(playbackReceipts).where(identity);
  if (existing && existing.audioOffsetMs >= input.audioOffsetMs) {
    return true;
  }
  const eligible = and(
    eq(interviews.interviewId, input.interviewId),
    eq(interviews.actorId, actorId),
    eq(interviews.revision, interview.revision),
    eq(interviews.streamGeneration, input.generation),
    ne(interviews.status, 'ended'),
  );
  const [written] = await db.batch([
    db
      .insert(playbackReceipts)
      .select(
        db
          .select({
            interviewId: interviews.interviewId,
            generation: sql<number>`${input.generation}`.as('generation'),
            audioOffsetMs: sql<number>`${input.audioOffsetMs}`.as('audio_offset_ms'),
            receivedAt: sql<number>`${input.receivedAt}`.as('received_at'),
          })
          .from(interviews)
          .where(eligible),
      )
      .onConflictDoUpdate({
        target: [playbackReceipts.interviewId, playbackReceipts.generation],
        set: { audioOffsetMs: input.audioOffsetMs, receivedAt: input.receivedAt },
        setWhere: lt(playbackReceipts.audioOffsetMs, input.audioOffsetMs),
      })
      .returning(),
    db
      .update(interviews)
      .set({
        revision: interview.revision + 1,
        updatedAt: sql`max(${interviews.updatedAt}, ${input.receivedAt})`,
      })
      .where(and(eligible, sql`changes() = 1`)),
  ]);
  if (written.length > 0) {
    return true;
  }
  const [replayed] = await db.select().from(playbackReceipts).where(identity);
  return Boolean(replayed && replayed.audioOffsetMs >= input.audioOffsetMs);
}

export async function markTranscriptIncomplete(
  db: Database,
  actorId: string,
  interviewId: string,
  now: number,
): Promise<void> {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('記録時刻が不正です。');
  }
  const [saved] = await db
    .update(interviews)
    .set({
      transcriptIncomplete: true,
      revision: sql`${interviews.revision} + 1`,
      updatedAt: sql`max(${interviews.updatedAt}, ${now})`,
    })
    .where(
      and(
        eq(interviews.interviewId, interviewId),
        eq(interviews.actorId, actorId),
        ne(interviews.status, 'ended'),
      ),
    )
    .returning();
  if (!saved) {
    throw new Error('会話の欠落情報を保存できませんでした。');
  }
}
