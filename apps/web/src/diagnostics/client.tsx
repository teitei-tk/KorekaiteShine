import { createClient } from '@korekaite/api-contracts/http/client';
import { getCheckJob, startCheckJob } from '@korekaite/api-contracts/http/diagnostics-sdk';
import type {
  CheckAccepted,
  CheckStartRequest,
  CheckStatus,
  CheckValidationDetail,
  CheckValidationError,
} from '@korekaite/api-contracts/http';
import {
  validateCheckAccepted,
  validateCheckStatus,
  validateCheckValidationError,
} from '@korekaite/api-contracts/http/diagnostics-validators';

type Scenario = CheckStartRequest['scenario'];

export async function getDiagnosticStatus(
  jobId: string,
  { baseUrl, fetcher = fetch }: { baseUrl: string; fetcher?: typeof fetch },
): Promise<CheckStatus> {
  const client = createClient({ baseUrl, fetch: fetcher });
  const { data, error, response } = await getCheckJob({
    client,
    path: { jobId },
  });
  if (!response || error instanceof Error) {
    throw error;
  }
  if (!response.ok) {
    throw new Error('診断の状態を取得できませんでした。');
  }
  if (!validateCheckStatus(data)) {
    throw new Error('診断の状態応答が契約と一致しません。');
  }
  return data;
}

export class DiagnosticValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly status = 400;
  readonly requestId: string;
  readonly details: CheckValidationDetail[];

  constructor(error: CheckValidationError) {
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
  const client = createClient({ baseUrl, fetch: fetcher });
  return {
    async start(): Promise<CheckAccepted> {
      const { data, error, response } = await startCheckJob({
        client,
        headers: { 'Idempotency-Key': key },
        body: { scenario },
      });
      if (!response || error instanceof Error) {
        throw error;
      }
      if (!response.ok) {
        if (response.status === 400 && validateCheckValidationError(error)) {
          throw new DiagnosticValidationError(error.error);
        }
        throw new Error('診断の受付を確認できませんでした。');
      }
      if (!validateCheckAccepted(data)) {
        throw new Error('診断の受付応答が契約と一致しません。');
      }
      return data;
    },
  };
}
