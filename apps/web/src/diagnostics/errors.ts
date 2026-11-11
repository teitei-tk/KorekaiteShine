import type { ErrorObject } from 'ajv';
import type { operations } from '@korekaite/api-contracts/http';

type ValidationBody = operations['startCheckJob']['responses'][400]['content']['application/json'];
export type ValidationDetail = ValidationBody['error']['details'][number];

type ErrorBody =
  | operations['startCheckJob']['responses'][409 | 415 | 500 | 503]['content']['application/json']
  | operations['getCheckJob']['responses'][404]['content']['application/json'];
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
    const property =
      error.keyword === 'required'
        ? error.params.missingProperty
        : error.keyword === 'additionalProperties'
          ? error.params.additionalProperty
          : undefined;
    const path =
      typeof property === 'string'
        ? `${error.instancePath}/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`
        : error.instancePath;
    const codes: Record<string, ValidationDetail['code']> = {
      required: 'REQUIRED',
      additionalProperties: 'UNRECOGNIZED_FIELD',
      pattern: 'INVALID_FORMAT',
      format: 'INVALID_FORMAT',
    };
    return {
      location: 'body',
      path,
      code: Object.hasOwn(codes, error.keyword) ? codes[error.keyword] : 'INVALID_VALUE',
      message: '入力項目を確認してください。',
    };
  });
}
