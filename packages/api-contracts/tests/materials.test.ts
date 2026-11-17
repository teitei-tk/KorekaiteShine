import { parseObject, objectAt } from '../scripts/schema-input.ts';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('HTTPの分析結果は保存IDを返し、AI出力に保存IDを要求しない', async () => {
  const document = parseObject(
    await readFile(new URL('../generated/http/openapi.json', import.meta.url), 'utf8'),
  );
  expect(
    objectAt(
      document,
      'paths',
      '/api/materials/analyze',
      'post',
      'responses',
      '200',
      'content',
      'application/json',
    ).schema,
  ).toEqual({ $ref: '#/components/schemas/SavedMaterialAnalysis' });
  const { validateSavedMaterialAnalysis } =
    await import('../generated/http/materials-validators.mjs');
  const value = {
    analysisId: 'analysis-1',
    themes: [{ title: '構成', heading: '判断', excerpt: '架空の経験' }],
  };
  expect(validateSavedMaterialAnalysis(value)).toBe(true);
  expect(validateSavedMaterialAnalysis({ ...value, analysisId: '' })).toBe(false);
  expect(validateSavedMaterialAnalysis({ themes: value.themes })).toBe(false);
});

test('生成validatorは未確認入力や不正な候補を補正せず拒否する', async () => {
  const { validateMaterialAnalysisRequest, validateMaterialAnalysisResult } =
    await import('../generated/http/materials-validators.mjs');
  expect(
    validateMaterialAnalysisRequest({ markdown: '# 判断\n制約を比較した', confirmed: true }),
  ).toBe(true);
  for (const input of [
    { markdown: '材料', confirmed: false },
    { markdown: '材料' },
    { markdown: '', confirmed: true },
    { markdown: 'a'.repeat(32_769), confirmed: true },
    { markdown: '材料', confirmed: true, model: 'arbitrary-model' },
    null,
  ]) {
    const before = JSON.stringify(input);
    expect(validateMaterialAnalysisRequest(input)).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  }
  const theme = { title: '静的配信の選定', heading: '判断', excerpt: '制約を比較した' };
  expect(validateMaterialAnalysisResult({ themes: [theme] })).toBe(true);
  for (const result of [
    { themes: [] },
    { themes: Array.from({ length: 6 }, () => theme) },
    { themes: [{ ...theme, excerpt: '' }] },
    { themes: [{ ...theme, instructions: '実行指示' }] },
    { themes: [theme], secret: 'extra' },
    null,
  ]) {
    expect(validateMaterialAnalysisResult(result)).toBe(false);
  }
});

test('材料分析は送信確認を必須とし、本文・候補・エラーを契約化する', async () => {
  const document = parseObject(
    await readFile(new URL('../generated/http/openapi.json', import.meta.url), 'utf8'),
  );
  const analyze = objectAt(document, 'paths', '/api/materials/analyze', 'post');
  expect(analyze).toBeDefined();
  expect(objectAt(analyze.requestBody).required).toBe(true);
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022対象を維持し、Object.keysが作成した配列だけを整列する。
  expect(Object.keys(objectAt(analyze.responses)).sort()).toEqual([
    '200',
    '400',
    '403',
    '413',
    '415',
    '429',
    '502',
    '503',
  ]);
  const request = objectAt(document, 'components', 'schemas', 'MaterialAnalysisRequest');
  expect(request.required).toEqual(['markdown', 'confirmed']);
  expect(objectAt(request, 'properties', 'confirmed').enum).toEqual([true]);
  expect(request.additionalProperties).toBe(false);
  expect(objectAt(document, 'components', 'schemas', 'MaterialAnalysisResult').required).toEqual([
    'themes',
  ]);
  expect(objectAt(document, 'components', 'schemas', 'MaterialTheme').required).toEqual([
    'title',
    'heading',
    'excerpt',
  ]);
  for (const response of Object.values(objectAt(analyze.responses)).map((value) =>
    objectAt(value),
  )) {
    expect(response.headers).toHaveProperty('Cache-Control');
  }
});
