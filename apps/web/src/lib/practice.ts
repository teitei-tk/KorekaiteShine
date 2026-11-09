import type { components } from '@korekaite/api-contracts/http';
import {
  validateLocalSession,
  validateInterviewHistory,
  validateInterviewDetail,
  validateApplicationError,
  validateRetryEvaluationAccepted,
} from '@korekaite/api-contracts/http/application-validators';
import {
  validateSavedMaterialAnalysis,
  validateMaterialErrorBody,
} from '@korekaite/api-contracts/http/materials-validators';
import {
  validateInterviewSession,
  validateInterviewErrorBody,
} from '@korekaite/api-contracts/http/interviews-validators';

export async function sessionToken(signal?: AbortSignal) {
  const session = await fetch('/api/local-session', { cache: 'no-store', signal });
  const access = await session.json();
  if (!session.ok || !validateLocalSession(access)) {
    throw new Error('ローカル接続を確認してください。');
  }
  return access.operationToken;
}
async function post(path: string, body: object) {
  const token = await sessionToken();
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Interview-Token': token },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    if (
      validateMaterialErrorBody(result) ||
      validateInterviewErrorBody(result) ||
      validateApplicationError(result)
    ) {
      throw new Error(result.error.message);
    }
    throw new Error('処理に失敗しました。もう一度お試しください。');
  }
  return result;
}
export async function analyzeMarkdown(markdown: string) {
  const value = await post('/api/materials/analyze', { markdown, confirmed: true });
  if (!validateSavedMaterialAnalysis(value)) {
    throw new Error('分析結果を読み取れませんでした。');
  }
  return value;
}
export async function prepareInterview(request: components['schemas']['CreateInterviewRequest']) {
  const value = await post('/api/interviews', request);
  if (!validateInterviewSession(value)) {
    throw new Error('面接の準備結果を読み取れませんでした。');
  }
  return value;
}

async function read(path: string, signal: AbortSignal) {
  await sessionToken(signal);
  const response = await fetch(path, { cache: 'no-store', signal });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(
      validateApplicationError(value) ? value.error.message : '記録を取得できませんでした。',
    );
  }
  return value;
}
export async function readHistory(
  cursor: components['schemas']['InterviewCursor'] | null,
  signal: AbortSignal,
) {
  const query = cursor
    ? '?' +
      new URLSearchParams({
        beforeCreatedAt: String(cursor.createdAt),
        beforeId: cursor.interviewId,
      })
    : '';
  const value = await read('/api/interview-history' + query, signal);
  if (!validateInterviewHistory(value)) {
    throw new Error('履歴を読み取れませんでした。');
  }
  return value;
}
export async function readDetail(id: string, signal: AbortSignal) {
  const value = await read('/api/interviews/' + encodeURIComponent(id), signal);
  if (!validateInterviewDetail(value)) {
    throw new Error('面接の記録を読み取れませんでした。');
  }
  return value;
}

export async function requestEvaluationRetry(interviewId: string, failedJobId: string) {
  const value = await post(`/api/interviews/${encodeURIComponent(interviewId)}/retry`, {
    failedJobId,
  });
  if (!validateRetryEvaluationAccepted(value)) {
    throw new Error('再評価の受付結果を確認できませんでした。');
  }
  return value;
}

export async function deleteSavedInterview(interviewId: string) {
  const token = await sessionToken();
  const response = await fetch(`/api/interviews/${encodeURIComponent(interviewId)}`, {
    method: 'DELETE',
    headers: { 'X-Interview-Token': token },
  });
  if (response.status !== 204) {
    throw new Error('削除の完了を確認できませんでした。もう一度お試しください。');
  }
}
