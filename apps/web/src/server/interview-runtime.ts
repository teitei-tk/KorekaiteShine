import { deleteInterviewRequest } from './delete-interview';
import { retryEvaluationRequest } from './retry-evaluation';
import { analyzeStoredMaterialRequest } from './stored-materials';
import { env } from 'cloudflare:workers';
import { Temporal } from '@js-temporal/polyfill';
import { createPrimaryDb } from '@korekaite/database/connection';
import { localAccess } from './local-access';
import { localSessionRequest } from './local-session';
import { createInterviewRequest } from './create-interview';
import { interviewHistoryRequest } from './interview-history';
import { interviewDetailRequest } from './interview-detail';
import { interviewLiveRequest, type InterviewSessions } from './interview-live';

export interface Bindings {
  APP_ENV: string;
  OPENAI_API_KEY?: string;
  MATERIAL_MODEL?: string;
  DB: import('@cloudflare/workers-types').D1Database;
  INTERVIEW_SESSION: InterviewSessions;
}
function bindings() {
  return env as Bindings;
}
export function bootstrap(request: Request) {
  return localSessionRequest(request, localAccess(bindings().APP_ENV));
}
function dependencies(operation: 'read' | 'write') {
  const current = bindings();
  const access = localAccess(current.APP_ENV);
  return {
    db: createPrimaryDb(current.DB),
    actor: (request: Request) => access.actor(request, operation),
    now: () => Temporal.Now.instant().epochMilliseconds,
  };
}
export function start(request: Request) {
  return createInterviewRequest(request, dependencies('write'));
}
export function history(request: Request) {
  return interviewHistoryRequest(request, dependencies('read'));
}
export function detail(request: Request, interviewId: string) {
  return interviewDetailRequest(request, interviewId, dependencies('read'));
}
export function live(request: Request, interviewId: string) {
  const current = bindings();
  const access = localAccess(current.APP_ENV);
  return interviewLiveRequest(request, interviewId, {
    environment: current.APP_ENV,
    actor: (incoming) => access.actor(incoming, 'websocket'),
    sessions: current.INTERVIEW_SESSION,
  });
}

export function analyze(request: Request) {
  const current = bindings();
  return analyzeStoredMaterialRequest(request, {
    ...dependencies('write'),
    newId: () => crypto.randomUUID(),
    apiKey: current.OPENAI_API_KEY ?? '',
    model: current.MATERIAL_MODEL ?? '',
  });
}

export function retry(request: Request, interviewId: string) {
  return retryEvaluationRequest(request, interviewId, {
    ...dependencies('write'),
    newId: () => crypto.randomUUID(),
  });
}

export function removeInterview(request: Request, id: string) {
  const current = bindings();
  return deleteInterviewRequest(request, id, {
    ...dependencies('write'),
    discard: async (actorId, interviewId) => {
      const response = await current.INTERVIEW_SESSION.getByName(
        `${current.APP_ENV}:interview:${interviewId}`,
      ).fetch(
        new Request(request.url, {
          method: 'DELETE',
          headers: { 'X-Interview-Actor': actorId, 'X-Interview-ID': interviewId },
        }),
      );
      if (response.status !== 204) {
        throw new Error('音声接続の終了処理を再実行してください。');
      }
    },
  });
}
