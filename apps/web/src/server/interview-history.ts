import { and, desc, eq, lt, or } from 'void/db';
import { interviews } from '@korekaite/database/interviews';
import type { createPrimaryDb } from '@korekaite/database/connection';
import {
  validateInterviewHistory,
  validateInterviewHistoryQuery,
} from '@korekaite/api-contracts/http/application-validators';
import { applicationFailure } from './application-response';

export async function interviewHistoryRequest(
  request: Request,
  deps: { db: ReturnType<typeof createPrimaryDb>; actor(request: Request): string | null },
): Promise<Response> {
  const actorId = deps.actor(request);
  if (!actorId) {
    return applicationFailure('FORBIDDEN');
  }
  const parameters = new URL(request.url).searchParams;
  const query: Record<string, string | number> = Object.create(null);
  for (const [name, value] of parameters) {
    if (Object.hasOwn(query, name)) {
      return applicationFailure('INVALID_REQUEST');
    }
    if (name === 'beforeCreatedAt') {
      if (!/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) {
        return applicationFailure('INVALID_REQUEST');
      }
      query[name] = Number(value);
    } else {
      query[name] = value;
    }
  }
  if (
    !validateInterviewHistoryQuery(query) ||
    (query.beforeCreatedAt === undefined) !== (query.beforeId === undefined)
  ) {
    return applicationFailure('INVALID_REQUEST');
  }
  try {
    const cursor =
      query.beforeCreatedAt === undefined
        ? undefined
        : or(
            lt(interviews.createdAt, query.beforeCreatedAt),
            and(
              eq(interviews.createdAt, query.beforeCreatedAt),
              lt(interviews.interviewId, query.beforeId!),
            ),
          );
    const rows = await deps.db
      .select({
        interviewId: interviews.interviewId,
        status: interviews.status,
        theme: interviews.themeTitle,
        createdAt: interviews.createdAt,
        activeMs: interviews.activeMs,
      })
      .from(interviews)
      .where(and(eq(interviews.actorId, actorId), cursor))
      .orderBy(desc(interviews.createdAt), desc(interviews.interviewId))
      .limit(21);
    const items = rows.slice(0, 20);
    const last = items.at(-1);
    const body = {
      items,
      next:
        rows.length > 20 && last
          ? { createdAt: last.createdAt, interviewId: last.interviewId }
          : null,
    };
    if (!validateInterviewHistory(body)) {
      return applicationFailure('UNAVAILABLE');
    }
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return applicationFailure('UNAVAILABLE');
  }
}
