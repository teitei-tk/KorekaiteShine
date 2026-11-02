import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

const document = JSON.parse(
  await readFile(new URL('../generated/http/openapi.json', import.meta.url), 'utf8'),
);

const jobId = '7e318b72-f255-4f17-845b-714d487ae621';
const timestamp = '2026-11-02T00:00:00.000Z';

test('診断応答は必須null項目・日時・試行回数・未知項目を検証する', async () => {
  const { validateCheckAccepted, validateCheckStatus } =
    await import('../generated/http/diagnostics-validators.mjs');
  const accepted = { jobId, scenario: 'success', acceptedAt: timestamp };
  const status = {
    ...accepted,
    status: 'pending',
    attemptCount: 0,
    updatedAt: timestamp,
    finishedAt: null,
    nextAttemptAt: null,
    lastErrorCode: null,
    checks: {
      doPersistence: 'pending',
      consumerCompletion: 'pending',
      dlqReceipt: 'not_expected',
    },
  };
  expect(validateCheckAccepted(accepted)).toBe(true);
  expect(validateCheckStatus(status)).toBe(true);
  for (const field of ['finishedAt', 'nextAttemptAt', 'lastErrorCode']) {
    const incomplete = Object.fromEntries(
      Object.entries(status).filter(([name]) => name !== field),
    );
    expect(validateCheckStatus(incomplete), field).toBe(false);
  }
  for (const attemptCount of [-1, 5, 1.5, '1']) {
    expect(validateCheckStatus({ ...status, attemptCount })).toBe(false);
  }
  for (const acceptedAt of [
    '2026-11-02T00:00:00Z',
    '2026-11-02T09:00:00.000+09:00',
    '2026-02-30T00:00:00.000Z',
  ]) {
    expect(validateCheckAccepted({ ...accepted, acceptedAt })).toBe(false);
    expect(validateCheckStatus({ ...status, acceptedAt })).toBe(false);
  }
  expect(validateCheckAccepted({ ...accepted, internal: true })).toBe(false);
  expect(validateCheckStatus({ ...status, internal: true })).toBe(false);
  expect(validateCheckStatus({ ...status, checks: { ...status.checks, internal: true } })).toBe(
    false,
  );
});

test('診断の開始と状態取得で成功・エラー・必須ヘッダーを定義する', () => {
  const start = document.paths['/api/diagnostics/check-jobs']?.post;
  const get = document.paths['/api/diagnostics/check-jobs/{jobId}']?.get;
  expect(start).toBeDefined();
  expect(get).toBeDefined();
  expect(Object.keys(start.responses).sort()).toEqual(['202', '400', '409', '415', '500', '503']);
  expect(Object.keys(get.responses).sort()).toEqual(['200', '400', '404', '500', '503']);
  expect(start.parameters).toContainEqual(
    expect.objectContaining({ in: 'header', name: 'Idempotency-Key', required: true }),
  );
  expect(start.requestBody.required).toBe(true);
  expect(start.requestBody.content['application/json']).toBeDefined();
  expect(start.responses['202'].headers.Location.required).toBe(true);
  for (const operation of [start, get]) {
    for (const status of Object.keys(operation.responses)) {
      expect(operation.responses[status].headers['Cache-Control']).toMatchObject({
        required: true,
        schema: { type: 'string', enum: ['no-store'] },
      });
    }
  }
});

test('診断の開始本文で3シナリオを受け付ける', async () => {
  const { validateCheckStart } = await import('../generated/http/diagnostics-validators.mjs');
  for (const scenario of ['success', 'retry_then_success', 'exhaust_retries']) {
    expect(validateCheckStart({ scenario })).toBe(true);
  }
});

test('開始本文の不正値を変換・補完・削除せず拒否する', async () => {
  const { validateCheckStart } = await import('../generated/http/diagnostics-validators.mjs');
  for (const input of [
    {},
    { scenario: 'unknown' },
    { scenario: 1 },
    { scenario: 'success', extra: 'preserved' },
    { scenario: 'success', jobId: '7e318b72-f255-4f17-845b-714d487ae621' },
    null,
    [],
    'success',
  ]) {
    const before = JSON.stringify(input);
    if (input !== null && typeof input === 'object') Object.freeze(input);
    expect(validateCheckStart(input), before).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  }
});

test('冪等キーとjobIdは小文字UUID v4だけを受け付ける', async () => {
  const { validateCheckIdempotencyKey, validateCheckJobId } =
    await import('../generated/http/diagnostics-validators.mjs');
  for (const validate of [validateCheckIdempotencyKey, validateCheckJobId]) {
    expect(validate(jobId)).toBe(true);
    for (const value of [
      undefined,
      null,
      '',
      1,
      jobId.toUpperCase(),
      jobId.replace('-4f17-', '-1f17-'),
      `${jobId}\n`,
    ]) {
      expect(validate(value), String(value)).toBe(false);
    }
  }
});

test('エラー応答はcode・requestId・入力検証の型付きdetailsを必須にする', async () => {
  const validators = await import('../generated/http/diagnostics-validators.mjs');
  const { diagnosticRequests } = await import('./fixtures/diagnostic-requests.ts');
  for (const fixture of diagnosticRequests) {
    const detail = {
      location: fixture.location,
      path: fixture.pointer,
      code: fixture.code,
      message: '入力内容を確認してください。',
    };
    const error = {
      code: 'VALIDATION_ERROR',
      message: '入力内容を確認してください。',
      requestId: jobId,
      details: [detail],
    };
    expect(validators.validateCheckValidationError({ error }), fixture.name).toBe(true);
    for (const field of ['location', 'path', 'code', 'message']) {
      const incomplete = Object.fromEntries(
        Object.entries(detail).filter(([name]) => name !== field),
      );
      expect(
        validators.validateCheckValidationError({ error: { ...error, details: [incomplete] } }),
      ).toBe(false);
    }
    expect(
      validators.validateCheckValidationError({
        error: { ...error, details: [{ ...detail, code: 'INTERNAL' }] },
      }),
    ).toBe(false);
    expect(
      validators.validateCheckValidationError({
        error: { ...error, details: [{ ...detail, value: 'raw input' }] },
      }),
    ).toBe(false);
    const withoutDetails = Object.fromEntries(
      Object.entries(error).filter(([name]) => name !== 'details'),
    );
    expect(validators.validateCheckValidationError({ error: withoutDetails })).toBe(false);
  }
  for (const [validate, code] of [
    [validators.validateCheckNotFound, 'JOB_NOT_FOUND'],
    [validators.validateCheckConflict, 'IDEMPOTENCY_KEY_CONFLICT'],
    [validators.validateCheckUnsupportedMediaType, 'UNSUPPORTED_MEDIA_TYPE'],
    [validators.validateCheckInternalError, 'INTERNAL_ERROR'],
    [validators.validateCheckUnavailable, 'SERVICE_UNAVAILABLE'],
  ] as const) {
    const error = { code, message: '処理できませんでした。', requestId: jobId };
    expect(validate({ error })).toBe(true);
    for (const field of ['code', 'message', 'requestId']) {
      expect(
        validate({
          error: Object.fromEntries(Object.entries(error).filter(([name]) => name !== field)),
        }),
      ).toBe(false);
    }
    for (const extra of [{ details: [] }, { retryable: true }, { type: 'internal' }]) {
      expect(validate({ error: { ...error, ...extra } })).toBe(false);
    }
    expect(validate({ error: { ...error, code: 'OTHER' } })).toBe(false);
    expect(validate({ error: { ...error, requestId: 'invalid' } })).toBe(false);
  }
});
