export type DocumentInput = unknown;

function isInputRecord(value: DocumentInput): value is Record<string, DocumentInput> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function inputRecord(value: DocumentInput, label: string): Record<string, DocumentInput> {
  if (!isInputRecord(value)) {
    throw new Error(`${label}: オブジェクトが必要です`);
  }
  return value;
}

export function optionalText(value: DocumentInput, label: string): string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${label}: 文字列が必要です`);
  }
  return value;
}
