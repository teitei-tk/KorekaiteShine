import { validateInterviewId } from '@korekaite/api-contracts/http/application-validators';
import { applicationFailure } from './application-response';

export interface InterviewSessions {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}
export async function interviewLiveRequest(
  request: Request,
  interviewId: string,
  deps: {
    environment: string;
    actor(request: Request): string | null;
    sessions: InterviewSessions;
  },
): Promise<Response> {
  const actorId = deps.actor(request);
  if (!actorId) {
    return applicationFailure('FORBIDDEN');
  }
  if (!validateInterviewId(interviewId)) {
    return applicationFailure('INVALID_REQUEST');
  }
  const headers = new Headers(request.headers);
  headers.set('X-Interview-Actor', actorId);
  headers.set('X-Interview-ID', interviewId);
  try {
    return await deps.sessions
      .getByName(`${deps.environment}:interview:${interviewId}`)
      .fetch(new Request(request, { headers }));
  } catch {
    return applicationFailure('UNAVAILABLE');
  }
}
