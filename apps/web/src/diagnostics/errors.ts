import type { ErrorObject } from 'ajv';
import type { GetCheckJobErrors, StartCheckJobErrors } from '@korekaite/api-contracts/http';

type ValidationBody = StartCheckJobErrors[400];
export type ValidationDetail = ValidationBody['error']['details'][number];

type ErrorBody = StartCheckJobErrors[409 | 415 | 500 | 503] | GetCheckJobErrors[404];
type ErrorCode = ErrorBody['error']['code'];
const errorStatuses: Record<ErrorCode, number> = {
  JOB_NOT_FOUND: 404,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

function logError(
  requestId: string,
  code: ErrorCode | ValidationBody['error']['code'],
  status: number,
): void {
  // 追跡用の識別情報だけを記録し、本文・詳細・内部例外をログへ流さない。
  console.info(JSON.stringify({ event: 'diagnostic_http_error', requestId, code, status }));
}

export function errorResponse(requestId: string, code: ErrorCode, message: string): Response {
  const status = errorStatuses[code];
  logError(requestId, code, status);
  return Response.json(
    { error: { code, message, requestId } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export function validationResponse(requestId: string, details: ValidationDetail[]): Response {
  const body: ValidationBody = {
    error: {
      code: 'VALIDATION_ERROR',
      message: '入力内容を確認してください。',
      requestId,
      details,
    },
  };
  logError(requestId, 'VALIDATION_ERROR', 400);
  return Response.json(body, { status: 400, headers: { 'Cache-Control': 'no-store' } });
}

export function bodyValidationDetails(
  errors: ErrorObject[] | null | undefined,
): ValidationDetail[] {
  return (errors ?? []).map((error): ValidationDetail => {
    let path = error.instancePath;
    let code: ValidationDetail['code'] = 'INVALID_VALUE';
    const property =
      error.keyword === 'required'
        ? error.params.missingProperty
        : error.keyword === 'additionalProperties'
          ? error.params.additionalProperty
          : undefined;
    if (typeof property === 'string') {
      path += `/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    }
    if (error.keyword === 'required') {
      code = 'REQUIRED';
    }
    if (error.keyword === 'additionalProperties') {
      code = 'UNRECOGNIZED_FIELD';
    }
    if (error.keyword === 'pattern' || error.keyword === 'format') {
      code = 'INVALID_FORMAT';
    }
    return { location: 'body', path, code, message: '入力項目を確認してください。' };
  });
}
