import { createHash } from 'node:crypto';
export interface CoverageDiagnostic {
  arrayValid: boolean;
  expected: number;
  received: number;
  missing: number;
  duplicates: number;
  foreign: number;
  invalid: number;
  missingIds: string[];
  duplicateIds: string[];
  foreignHashes: string[];
}
const sample = 4;
export function coverageDiagnostic(expected: string[], received: string[]): CoverageDiagnostic {
  const arrayValid = Array.isArray(received);
  const values = arrayValid ? received : [];
  const counts = new Map<string, number>();
  let invalid = 0;
  for (const value of values) {
    if (typeof value !== 'string') {
      invalid++;
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const missing = expected.filter((id) => !counts.has(id));
  const duplicateIds = expected.filter((id) => (counts.get(id) ?? 0) > 1);
  const foreign = [...counts.keys()].filter((id) => !expected.includes(id));
  return {
    arrayValid,
    expected: expected.length,
    received: values.length,
    missing: missing.length,
    duplicates: [...counts.values()].reduce((n, c) => n + c - 1, 0),
    foreign: foreign.length,
    invalid,
    missingIds: missing.slice(0, sample),
    duplicateIds: duplicateIds.slice(0, sample),
    foreignHashes: foreign
      .slice(0, sample)
      .map((id) => createHash('sha256').update(id).digest('hex')),
  };
}
export function validCoverage(
  value: Partial<CoverageDiagnostic> | null | undefined,
): value is CoverageDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = [
    'arrayValid',
    'expected',
    'received',
    'missing',
    'duplicates',
    'foreign',
    'invalid',
    'missingIds',
    'duplicateIds',
    'foreignHashes',
  ];
  if (Object.keys(value).some((k) => !keys.includes(k)) || typeof value.arrayValid !== 'boolean')
    return false;
  const counts = [
    value.expected,
    value.received,
    value.missing,
    value.duplicates,
    value.foreign,
    value.invalid,
  ];
  if (
    !counts.every(
      (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000,
    )
  )
    return false;
  const ids = (values: string[] | undefined, pattern: RegExp, limit: number) =>
    Array.isArray(values) &&
    values.length <= limit &&
    new Set(values).size === values.length &&
    values.every((id) => typeof id === 'string' && pattern.test(id));
  return (
    value.missing! <= value.expected! &&
    (value.duplicates === 0 || value.expected! - value.missing! + value.foreign! > 0) &&
    value.received ===
      value.expected! - value.missing! + value.duplicates! + value.foreign! + value.invalid! &&
    (value.arrayValid || value.received === 0) &&
    ids(value.missingIds, /^[a-f0-9]{16}$/, Math.min(sample, value.missing!)) &&
    value.missingIds!.length === Math.min(sample, value.missing!) &&
    ids(
      value.duplicateIds,
      /^[a-f0-9]{16}$/,
      Math.min(sample, value.duplicates!, value.expected! - value.missing!),
    ) &&
    (value.duplicates === 0 || value.foreign! > 0 || value.duplicateIds!.length > 0) &&
    !value.duplicateIds!.some((id) => value.missingIds!.includes(id)) &&
    ids(value.foreignHashes, /^[a-f0-9]{64}$/, Math.min(sample, value.foreign!)) &&
    value.foreignHashes!.length === Math.min(sample, value.foreign!)
  );
}
export function renderCoverage(value: CoverageDiagnostic): string {
  if (!validCoverage(value)) throw new Error('確認範囲の診断が不正です');
  return [
    `確認対象の照合: 期待${value.expected}件、回答${value.received}件。欠落${value.missing}件、重複${value.duplicates}件（余分な出現数）、担当外${value.foreign}件（異なる値）、文字列以外${value.invalid}件。`,
    ...(value.arrayValid ? [] : ['回答の確認済み一覧が配列ではありません。']),
    `以下の一覧は各最大${sample}件です。担当外の値は原文を保存せずSHA-256で照合します。`,
    `欠落した期待ID: ${value.missingIds.join(', ') || 'なし'}`,
    `重複した期待ID: ${value.duplicateIds.join(', ') || 'なし'}`,
    `担当外IDのハッシュ: ${value.foreignHashes.join(', ') || 'なし'}`,
  ].join('\n\n');
}
