import { DiagnosticDatabaseError } from '../server/repositories/database-error';
import { bodyValidationDetails, errorResponse, validationResponse } from './errors';
import {
  validateCheckIdempotencyKey,
  validateCheckStart,
} from '@korekaite/api-contracts/http/diagnostics-validators';
import {
  acceptDiagnosticJob,
  type AcceptanceContext,
} from '../server/repositories/diagnostic-jobs';

export interface CheckDependencies extends AcceptanceContext {
  scheduleInitialization?(jobId: string): void;
}

export async function acceptCheck(request: Request, deps: CheckDependencies): Promise<Response> {
  const requestId = deps.newId();
  const headers = { 'Cache-Control': 'no-store' };
  // 拒否する要求も本文を消費し、ローカルランタイムで次の接続再利用を壊さない。
  const body = await request.text().catch(() => null);
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  ) {
    return errorResponse(requestId, 'UNSUPPORTED_MEDIA_TYPE', 'JSON形式で送信してください。');
  }
  const key = request.headers.get('Idempotency-Key');
  if (!validateCheckIdempotencyKey(key)) {
    return validationResponse(requestId, [
      {
        location: 'header',
        path: 'Idempotency-Key',
        code: key === null ? 'REQUIRED' : 'INVALID_FORMAT',
        message: '冪等キーを確認してください。',
      },
    ]);
  }
  let input;
  try {
    if (body === null) {
      throw new Error('本文を読み取れませんでした。');
    }
    input = JSON.parse(body);
  } catch {
    return validationResponse(requestId, [
      {
        location: 'body',
        path: '',
        code: 'INVALID_FORMAT',
        message: 'JSON形式を確認してください。',
      },
    ]);
  }
  if (!validateCheckStart(input)) {
    return validationResponse(requestId, bodyValidationDetails(validateCheckStart.errors));
  }
  try {
    const accepted = await acceptDiagnosticJob(deps, key, input);
    if (accepted === 'conflict') {
      return errorResponse(
        requestId,
        'IDEMPOTENCY_KEY_CONFLICT',
        '同じ冪等キーが異なる入力で使用されています。',
      );
    }
    try {
      deps.scheduleInitialization?.(accepted.jobId);
    } catch {
      // 受付は既に永続化済み。継続処理の開始失敗で受付結果を取り消さない。
      console.info(
        JSON.stringify({
          event: 'diagnostic_initialization_deferred',
          requestId,
          jobId: accepted.jobId,
        }),
      );
    }
    return Response.json(accepted, {
      status: 202,
      headers: { ...headers, Location: `/api/diagnostics/check-jobs/${accepted.jobId}` },
    });
  } catch (error) {
    if (!(error instanceof DiagnosticDatabaseError)) {
      return errorResponse(requestId, 'INTERNAL_ERROR', '内部エラーが発生しました。');
    }
    return errorResponse(
      requestId,
      'SERVICE_UNAVAILABLE',
      '受付を確認できません。同じキーで再送してください。',
    );
  }
}
