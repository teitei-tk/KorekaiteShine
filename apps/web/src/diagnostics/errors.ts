import type { ErrorObject } from 'ajv';
import type { operations } from '@korekaite/api-contracts/http';

type ValidationBody = operations['startCheckJob']['responses'][400]['content']['application/json'];
export type ValidationDetail = ValidationBody['error']['details'][number];

export function validationResponse(requestId: string, details: ValidationDetail[]): Response {
  const body: ValidationBody = {
    error: {
      code: 'VALIDATION_ERROR',
      message: '入力内容を確認してください。',
      requestId,
      details,
    },
  };
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
    if (typeof property === 'string')
      path += `/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (error.keyword === 'required') code = 'REQUIRED';
    if (error.keyword === 'additionalProperties') code = 'UNRECOGNIZED_FIELD';
    if (error.keyword === 'pattern' || error.keyword === 'format') code = 'INVALID_FORMAT';
    return { location: 'body', path, code, message: '入力項目を確認してください。' };
  });
}
