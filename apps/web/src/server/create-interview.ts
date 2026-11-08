import type { components } from '@korekaite/api-contracts/http';
import {
  validateCreateInterviewRequest,
  validateInterviewSession,
  validateInterviewErrorBody,
} from '@korekaite/api-contracts/http/interviews-validators';
import type { createPrimaryDb } from '@korekaite/database/connection';
import { createInterview, findInterview } from './repositories/interviews';
import { findMaterialTheme } from './repositories/materials';
import { readJsonBody } from './json-body';

type Code = components['schemas']['InterviewErrorBody']['error']['code'];
const errors: Record<Code, readonly [number, string]> = {
  INVALID_REQUEST: [400, '開始するテーマと補足を確認してください。'],
  FORBIDDEN: [403, 'この要求は許可されていません。'],
  REQUEST_TOO_LARGE: [413, '送信内容が大きすぎます。'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'JSON形式で送信してください。'],
  ANALYSIS_NOT_FOUND: [404, '分析候補が見つからないか、有効期限が切れています。'],
  INTERVIEW_CONFLICT: [409, '進行中の面接、または開始要求の内容を確認してください。'],
  STORAGE_UNAVAILABLE: [503, '面接を保存できませんでした。同じ開始要求で再度お試しください。'],
};
function failure(code: Code): Response {
  const [status, message] = errors[code];
  const body = { error: { code, message } };
  if (!validateInterviewErrorBody(body)) {
    throw new Error('面接エラー契約が不正です。');
  }
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
function accepted(row: NonNullable<Awaited<ReturnType<typeof findInterview>>>): Response {
  const value = {
    interviewId: row.interviewId,
    status: row.status,
    theme: row.themeTitle,
    createdAt: row.createdAt,
    activeMs: row.activeMs,
  };
  if (!validateInterviewSession(value)) {
    return failure('STORAGE_UNAVAILABLE');
  }
  return Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
}
export async function createInterviewRequest(
  request: Request,
  deps: {
    db: ReturnType<typeof createPrimaryDb>;
    actor(request: Request): string | null;
    now(): number;
  },
): Promise<Response> {
  const actorId = deps.actor(request);
  if (!actorId) {
    return failure('FORBIDDEN');
  }
  const parsed = await readJsonBody(request, 30_000);
  if (!parsed.ok) {
    return failure(parsed.code);
  }
  if (!validateCreateInterviewRequest(parsed.value)) {
    return failure('INVALID_REQUEST');
  }
  const input = parsed.value;
  try {
    const existing = await findInterview(deps.db, actorId, input.interviewId);
    if (existing) {
      return existing.analysisId === input.analysisId &&
        existing.themeIndex === input.themeIndex &&
        existing.background === input.background
        ? accepted(existing)
        : failure('INTERVIEW_CONFLICT');
    }
    const now = deps.now();
    const selected = await findMaterialTheme(
      deps.db,
      actorId,
      input.analysisId,
      input.themeIndex,
      now,
    );
    if (!selected) {
      return failure('ANALYSIS_NOT_FOUND');
    }
    const row = await createInterview(
      deps.db,
      {
        ...input,
        actorId,
        materialHash: selected.materialHash,
        themeTitle: selected.theme.title,
        themeHeading: selected.theme.heading,
        themeExcerpt: selected.theme.excerpt,
      },
      now,
    );
    return row ? accepted(row) : failure('INTERVIEW_CONFLICT');
  } catch {
    return failure('STORAGE_UNAVAILABLE');
  }
}
