import { Temporal } from '@js-temporal/polyfill';
import { usageLimits } from '@korekaite/runtime-config/limits';
import { usedAudioMs } from '@korekaite/database/audio-periods';
import { and, asc, desc, eq } from 'void/db';
import {
  interviews,
  transcriptFragments,
  playbackReceipts,
  evaluationInputs,
} from '@korekaite/database/interviews';
import { jobs, jobAttempts } from '@korekaite/database/jobs';
import type { createPrimaryDb } from '@korekaite/database/connection';
import {
  validateInterviewDetail,
  validateInterviewId,
} from '@korekaite/api-contracts/http/application-validators';
import { applicationFailure } from './application-response';

export async function interviewDetailRequest(
  request: Request,
  interviewId: string,
  deps: { db: ReturnType<typeof createPrimaryDb>; actor(request: Request): string | null },
): Promise<Response> {
  const actorId = deps.actor(request);
  if (!actorId) {
    return applicationFailure('FORBIDDEN');
  }
  if (!validateInterviewId(interviewId)) {
    return applicationFailure('INVALID_REQUEST');
  }
  try {
    const [row] = await deps.db
      .select()
      .from(interviews)
      .where(and(eq(interviews.interviewId, interviewId), eq(interviews.actorId, actorId)));
    if (!row) {
      return applicationFailure('NOT_FOUND');
    }
    const transcripts = await deps.db
      .select({
        fragmentId: transcriptFragments.fragmentId,
        sequence: transcriptFragments.sequence,
        generation: transcriptFragments.generation,
        speaker: transcriptFragments.speaker,
        content: transcriptFragments.content,
        sourceStartMs: transcriptFragments.sourceStartMs,
        sourceEndMs: transcriptFragments.sourceEndMs,
        receivedAt: transcriptFragments.receivedAt,
      })
      .from(transcriptFragments)
      .where(eq(transcriptFragments.interviewId, interviewId))
      .orderBy(asc(transcriptFragments.sequence));
    const playback = await deps.db
      .select({
        generation: playbackReceipts.generation,
        audioOffsetMs: playbackReceipts.audioOffsetMs,
        receivedAt: playbackReceipts.receivedAt,
      })
      .from(playbackReceipts)
      .where(eq(playbackReceipts.interviewId, interviewId))
      .orderBy(asc(playbackReceipts.generation));
    const [job] = await deps.db
      .select({
        jobId: jobs.jobId,
        status: jobs.status,
        attemptCount: jobs.attemptCount,
        nextAttemptAt: jobs.nextAttemptAt,
        lastErrorCode: jobs.lastErrorCode,
      })
      .from(evaluationInputs)
      .innerJoin(jobs, eq(jobs.jobId, evaluationInputs.jobId))
      .where(
        and(
          eq(evaluationInputs.interviewId, interviewId),
          eq(jobs.actorId, actorId),
          eq(jobs.purpose, 'evaluation'),
        ),
      )
      .orderBy(desc(evaluationInputs.createdAt), desc(evaluationInputs.jobId))
      .limit(1);
    const resultState = { result: null as object | null };
    if (job?.status === 'completed') {
      const [attempt] = await deps.db
        .select({ resultJson: jobAttempts.resultJson })
        .from(jobAttempts)
        .where(
          and(eq(jobAttempts.jobId, job.jobId), eq(jobAttempts.attemptNumber, job.attemptCount)),
        );
      if (!attempt?.resultJson) {
        return applicationFailure('UNAVAILABLE');
      }
      resultState.result = JSON.parse(attempt.resultJson);
    }
    const now = Temporal.Now.instant().epochMilliseconds;
    const start = Temporal.Instant.fromEpochMilliseconds(now)
      .toZonedDateTimeISO(usageLimits.timeZone)
      .startOfDay();
    const used = await usedAudioMs(deps.db, actorId, {
      start: start.epochMilliseconds,
      end: start.add({ days: 1 }).epochMilliseconds,
      day: start.toPlainDate().toString(),
      now,
    });
    const body = {
      audioRemainingMs: Math.max(0, usageLimits.audioSecondsPerDay * 1000 - used),
      session: {
        interviewId: row.interviewId,
        status: row.status,
        theme: row.themeTitle,
        createdAt: row.createdAt,
        activeMs: row.activeMs,
      },
      material: { title: row.themeTitle, heading: row.themeHeading, excerpt: row.themeExcerpt },
      background: row.background,
      transcriptIncomplete: row.transcriptIncomplete,
      transcripts,
      playback,
      evaluation: job ? { ...job, result: resultState.result } : null,
    };
    if (!validateInterviewDetail(body)) {
      return applicationFailure('UNAVAILABLE');
    }
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return applicationFailure('UNAVAILABLE');
  }
}
