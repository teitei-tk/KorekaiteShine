import { and, eq, sql, notExists } from 'void/db';
import { interviews, deletedInterviews } from '@korekaite/database/interviews';
import type { createPrimaryDb } from '@korekaite/database/connection';

type Database = ReturnType<typeof createPrimaryDb>;
type Interview = typeof interviews.$inferSelect;
type NewInterview = Pick<
  Interview,
  | 'interviewId'
  | 'actorId'
  | 'materialHash'
  | 'themeTitle'
  | 'themeHeading'
  | 'themeExcerpt'
  | 'background'
> &
  Partial<Pick<Interview, 'analysisId' | 'themeIndex'>>;

export async function findInterview(
  db: Database,
  actorId: string,
  interviewId: string,
): Promise<Interview | null> {
  const [row] = await db
    .select()
    .from(interviews)
    .where(and(eq(interviews.interviewId, interviewId), eq(interviews.actorId, actorId)));
  return row ?? null;
}

/** inputの材料は、本人に属する検証済み分析結果からサーバー側で確定する。 */
export async function createInterview(
  db: Database,
  input: NewInterview,
  now: number,
): Promise<Interview | null> {
  const [created] = await db
    .insert(interviews)
    .select(
      db
        .select({
          interviewId: sql<Interview['interviewId']>`${input.interviewId}`.as('interview_id'),
          actorId: sql<Interview['actorId']>`${input.actorId}`.as('actor_id'),
          analysisId: sql<Interview['analysisId']>`${input.analysisId ?? null}`.as('analysis_id'),
          themeIndex: sql<Interview['themeIndex']>`${input.themeIndex ?? null}`.as('theme_index'),
          materialHash: sql<Interview['materialHash']>`${input.materialHash}`.as('material_hash'),
          themeTitle: sql<Interview['themeTitle']>`${input.themeTitle}`.as('theme_title'),
          themeHeading: sql<Interview['themeHeading']>`${input.themeHeading}`.as('theme_heading'),
          themeExcerpt: sql<Interview['themeExcerpt']>`${input.themeExcerpt}`.as('theme_excerpt'),
          background: sql<Interview['background']>`${input.background}`.as('background'),
          status: sql<Interview['status']>`'ready'`.as('status'),
          revision: sql<Interview['revision']>`0`.as('revision'),
          generation: sql<Interview['generation']>`0`.as('generation'),
          streamGeneration: sql<Interview['streamGeneration']>`NULL`.as('stream_generation'),
          transcriptIncomplete: sql<Interview['transcriptIncomplete']>`0`.as(
            'transcript_incomplete',
          ),
          activeMs: sql<Interview['activeMs']>`0`.as('active_ms'),
          activeSince: sql<Interview['activeSince']>`NULL`.as('active_since'),
          deadline: sql<Interview['deadline']>`NULL`.as('deadline'),
          createdAt: sql<Interview['createdAt']>`${now}`.as('created_at'),
          updatedAt: sql<Interview['updatedAt']>`${now}`.as('updated_at'),
          endedAt: sql<Interview['endedAt']>`NULL`.as('ended_at'),
        })
        .from(sql`(SELECT 1) AS seed`)
        .where(
          notExists(
            db
              .select()
              .from(deletedInterviews)
              .where(eq(deletedInterviews.interviewId, input.interviewId)),
          ),
        ),
    )
    .onConflictDoNothing()
    .returning();
  if (created) {
    return created;
  }
  const [existing] = await db
    .select()
    .from(interviews)
    .where(
      and(eq(interviews.interviewId, input.interviewId), eq(interviews.actorId, input.actorId)),
    );
  if (
    !existing ||
    existing.materialHash !== input.materialHash ||
    existing.themeTitle !== input.themeTitle ||
    existing.themeHeading !== input.themeHeading ||
    existing.themeExcerpt !== input.themeExcerpt ||
    existing.background !== input.background ||
    existing.analysisId !== (input.analysisId ?? null) ||
    existing.themeIndex !== (input.themeIndex ?? null)
  ) {
    return null;
  }
  return existing;
}
