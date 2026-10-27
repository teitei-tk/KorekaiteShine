import { expect, it } from 'vitest';
import { coverageDiagnostic, validCoverage, renderCoverage } from './coverage-diagnostic.ts';
import { detail } from './diagnostics.ts';
import { workerFailure, ReviewFailure } from './failure.ts';
import { decodeWorkerResult } from './orchestrate.ts';
it('欠落・重複・担当外を区別し、モデルの原文を保存しない', () => {
  const ids = ['a'.repeat(16), 'b'.repeat(16)];
  const value = coverageDiagnostic(ids, [ids[0], ids[0], 'SECRET', 'SECRET']);
  expect(value).toMatchObject({
    expected: 2,
    received: 4,
    missing: 1,
    duplicates: 2,
    foreign: 1,
    invalid: 0,
    missingIds: [ids[1]],
    duplicateIds: [ids[0]],
  });
  expect(validCoverage(value)).toBe(true);
  expect(JSON.stringify(value)).not.toContain('SECRET');
  expect(renderCoverage(value)).toContain('欠落1件');
});
it('診断を子プロセス境界で失わない', () => {
  const coverage = coverageDiagnostic(['a'.repeat(16)], []);
  const payload = workerFailure(
    new ReviewFailure('OUTPUT_INVALID', 'SECRET', detail('COVERAGE_MISMATCH', [], coverage)),
  );
  expect(payload.detail).toMatchObject({ coverage });
  expect(() => decodeWorkerResult(JSON.stringify(payload))).toThrow(
    expect.objectContaining({ detail: expect.objectContaining({ coverage }) }),
  );
});
it('診断の不正な件数・任意文字列・余分なフィールドを拒否する', () => {
  const valid = coverageDiagnostic(['a'.repeat(16)], []);
  expect(validCoverage({ ...valid, received: 4 })).toBe(false);
  expect(validCoverage({ ...valid, missingIds: ['SECRET'] })).toBe(false);
  const extra = { ...valid, body: 'SECRET' };
  expect(validCoverage(extra)).toBe(false);
});
it('配列以外・文字列以外の応答も自由文を残さず分類する', () => {
  const scalar = JSON.parse('"SECRET"');
  expect(coverageDiagnostic(['a'.repeat(16)], scalar)).toMatchObject({
    arrayValid: false,
    received: 0,
    missing: 1,
  });
  const mixed = coverageDiagnostic(['a'.repeat(16)], JSON.parse('[null,42,{"secret":"SECRET"}]'));
  expect(mixed).toMatchObject({ arrayValid: true, invalid: 3, received: 3, missing: 1 });
  expect(validCoverage(mixed)).toBe(true);
  expect(JSON.stringify(mixed)).not.toContain('SECRET');
});
it('69件の不一致でも診断のサンプルを制限しActions概要に内訳を表示する', async () => {
  const { renderDiagnostic, validDiagnostic } = await import('./diagnostics.ts');
  const expected = Array.from({ length: 69 }, (_, i) => i.toString(16).padStart(16, '0'));
  const coverage = coverageDiagnostic(expected, Array(69).fill(expected[0]));
  expect(coverage).toMatchObject({
    expected: 69,
    received: 69,
    missing: 68,
    duplicates: 68,
    foreign: 0,
  });
  expect(coverage.missingIds).toHaveLength(4);
  const diagnostic = { ...detail('COVERAGE_MISMATCH', [], coverage) };
  expect(validDiagnostic(diagnostic)).toBe(true);
  expect(renderDiagnostic(diagnostic)).toContain('欠落68件、重複68件');
});
it('敵対的な1000通りの応答で集計・秘匿・診断の整合性を維持する', () => {
  const expected = Array.from({ length: 8 }, (_, i) => i.toString(16).padStart(16, '0'));
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let n = 0; n < 1000; n++) {
    const values: (string | number | null)[] = Array.from({ length: random() % 80 }, () => {
      const i = random() % 12;
      return i < 8 ? expected[i] : i === 8 ? null : i === 9 ? 42 : `SECRET_${i}`;
    });
    const received: string[] = JSON.parse(JSON.stringify(values));
    const diagnostic = coverageDiagnostic(expected, received);
    expect(validCoverage(diagnostic)).toBe(true);
    expect(diagnostic.received).toBe(values.length);
    expect(diagnostic.missing).toBe(expected.filter((id) => !values.includes(id)).length);
    expect(diagnostic.invalid).toBe(values.filter((v) => typeof v !== 'string').length);
    expect(JSON.stringify(diagnostic)).not.toContain('SECRET');
    expect(renderCoverage(diagnostic)).not.toContain('SECRET');
  }
});
it('存在するIDがゼロなのに重複がある偽造診断を拒否する', () => {
  const forged = { ...coverageDiagnostic([], []), received: 1, duplicates: 1 };
  expect(validCoverage(forged)).toBe(false);
});
