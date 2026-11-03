import createClient from 'openapi-fetch';
import type { components, paths } from '@korekaite/api-contracts/http';
import {
  validateCheckAccepted,
  validateCheckStatus,
  validateCheckValidationError,
} from '@korekaite/api-contracts/http/diagnostics-validators';

type Scenario = components['schemas']['CheckStartRequest']['scenario'];

export async function getDiagnosticStatus(
  jobId: string,
  { baseUrl, fetcher = fetch }: { baseUrl: string; fetcher?: typeof fetch },
): Promise<components['schemas']['CheckStatus']> {
  const client = createClient<paths>({ baseUrl, fetch: fetcher });
  const { data, response } = await client.GET('/api/diagnostics/check-jobs/{jobId}', {
    params: { path: { jobId } },
  });
  if (!response.ok) throw new Error('診断の状態を取得できませんでした。');
  if (!validateCheckStatus(data)) throw new Error('診断の状態応答が契約と一致しません。');
  return data;
}

export class DiagnosticValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly status = 400;
  readonly requestId: string;
  readonly details: components['schemas']['CheckValidationDetail'][];

  constructor(error: components['schemas']['CheckValidationError']) {
    super('入力内容を確認してください。');
    this.name = 'DiagnosticValidationError';
    this.requestId = error.requestId;
    this.details = error.details;
  }
}

export function createDiagnosticRun(
  scenario: Scenario,
  {
    baseUrl,
    fetcher = fetch,
    newId = () => crypto.randomUUID(),
  }: { baseUrl: string; fetcher?: typeof fetch; newId?: () => string },
) {
  const key = newId();
  const client = createClient<paths>({ baseUrl, fetch: fetcher });
  return {
    async start(): Promise<components['schemas']['CheckAccepted']> {
      const { data, error, response } = await client.POST('/api/diagnostics/check-jobs', {
        params: { header: { 'Idempotency-Key': key } },
        body: { scenario },
      });
      if (!response.ok) {
        if (response.status === 400 && validateCheckValidationError(error))
          throw new DiagnosticValidationError(error.error);
        throw new Error('診断の受付を確認できませんでした。');
      }
      if (!validateCheckAccepted(data)) throw new Error('診断の受付応答が契約と一致しません。');
      return data;
    },
  };
}
