import { bodyValidationDetails, validationResponse } from './errors';
import {
  validateCheckIdempotencyKey,
  validateCheckStart,
} from '@korekaite/api-contracts/http/diagnostics-validators';
import {
  acceptDiagnosticJob,
  type AcceptanceContext,
} from '../server/repositories/diagnostic-jobs';

export type CheckDependencies = AcceptanceContext;

export async function acceptCheck(request: Request, deps: CheckDependencies): Promise<Response> {
  const requestId = deps.newId();
  const headers = { 'Cache-Control': 'no-store' };
  const error = (status: number, code: string, message: string) =>
    Response.json({ error: { code, message, requestId } }, { status, headers });
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  ) {
    return error(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON形式で送信してください。');
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
    input = await request.json();
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
    if (accepted === 'conflict')
      return error(409, 'IDEMPOTENCY_KEY_CONFLICT', '同じ冪等キーが異なる入力で使用されています。');
    return Response.json(accepted, {
      status: 202,
      headers: { ...headers, Location: `/api/diagnostics/check-jobs/${accepted.jobId}` },
    });
  } catch {
    return error(503, 'SERVICE_UNAVAILABLE', '受付を確認できません。同じキーで再送してください。');
  }
}
