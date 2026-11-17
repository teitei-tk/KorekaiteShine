import type { JsonValue } from '@korekaite/api-contracts/json';
import { parseJson } from '@korekaite/api-contracts/json';
import {
  validateCheckValidationError,
  validateCheckAccepted,
  validateCheckStatus,
  validateCheckNotFound,
  validateCheckUnavailable,
} from '@korekaite/api-contracts/http/diagnostics-validators';

/** HTTP成功応答を、原本から生成した受付契約で検証する。 */
export async function readCheckAccepted(response: Response) {
  const value = parseJson(await response.text());
  if (!validateCheckAccepted(value)) {
    throw new Error('診断ジョブの受付応答が契約に一致しません。');
  }
  return value;
}

/** 状態取得応答を、原本から生成した状態契約で検証する。 */
export async function readCheckStatus(response: Response) {
  const value = parseJson(await response.text());
  if (!validateCheckStatus(value)) {
    throw new Error('診断ジョブの状態応答が契約に一致しません。');
  }
  return value;
}

export async function readCheckNotFound(response: Response) {
  const value = parseJson(await response.text());
  if (!validateCheckNotFound(value)) {
    throw new Error('診断ジョブのエラー応答が契約に一致しません。');
  }
  return value;
}

export async function readCheckUnavailable(response: Response) {
  const value = parseJson(await response.text());
  if (!validateCheckUnavailable(value)) {
    throw new Error('診断ジョブのエラー応答が契約に一致しません。');
  }
  return value;
}

/** 契約外の診断fixture応答もJSONの値として扱い、anyを伝播させない。 */
export async function readJson(response: Response) {
  return parseJson(await response.text());
}
export function jsonObject(value: JsonValue) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('JSONオブジェクトが必要です。');
  }
  return value;
}
export function jsonString(value: JsonValue) {
  if (typeof value !== 'string') {
    throw new TypeError('JSON文字列が必要です。');
  }
  return value;
}
export async function readJsonObject(response: Response) {
  return jsonObject(await readJson(response));
}
export async function readJob(response: Response) {
  const value = await readJsonObject(response);
  return { ...value, jobId: jsonString(value.jobId) };
}
export async function readInitializationObject(response: Response) {
  const value = await readJsonObject(response);
  return {
    ...value,
    jobId: jsonString(value.jobId),
    firstReceivedAt: jsonString(value.firstReceivedAt),
  };
}
export async function readBootstrap(response: Response) {
  const value = await readJsonObject(response);
  return { ...value, operationToken: jsonString(value.operationToken) };
}
export async function readAnalysis(response: Response) {
  const value = await readJsonObject(response);
  return { ...value, analysisId: jsonString(value.analysisId) };
}
export async function readCheckValidationError(response: Response) {
  const value = await readJson(response);
  if (!validateCheckValidationError(value)) {
    throw new TypeError('診断入力エラー応答が契約に一致しません。');
  }
  return value;
}
export async function readReceipt(response: Response) {
  const value = await readJson(response);
  if (value === null) {
    return null;
  }
  const record = jsonObject(value);
  return { ...record, queue: jsonString(record.queue), message: jsonObject(record.message) };
}
export async function readJsonArray(response: Response) {
  const value = await readJson(response);
  if (!Array.isArray(value)) {
    throw new TypeError('JSON配列が必要です。');
  }
  return value;
}
