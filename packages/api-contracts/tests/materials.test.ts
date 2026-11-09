import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('HTTPの分析結果は保存IDを返し、AI出力に保存IDを要求しない', async () => {
  const document = JSON.parse(
    await readFile(new URL('../generated/http/openapi.json', import.meta.url), 'utf8'),
  );
  expect(
    document.paths['/api/materials/analyze'].post.responses['200'].content['application/json']
      .schema,
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
    { markdown: 'a'.repeat(32769), confirmed: true },
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
  const document = JSON.parse(
    await readFile(new URL('../generated/http/openapi.json', import.meta.url), 'utf8'),
  );
  const analyze = document.paths['/api/materials/analyze']?.post;
  expect(analyze).toBeDefined();
  expect(analyze.requestBody.required).toBe(true);
  expect(Object.keys(analyze.responses).sort()).toEqual([
    '200',
    '400',
    '403',
    '413',
    '415',
    '429',
    '502',
    '503',
  ]);
  const request = document.components.schemas.MaterialAnalysisRequest;
  expect(request.required).toEqual(['markdown', 'confirmed']);
  expect(request.properties.confirmed.enum).toEqual([true]);
  expect(request.additionalProperties).toBe(false);
  expect(document.components.schemas.MaterialAnalysisResult.required).toEqual(['themes']);
  expect(document.components.schemas.MaterialTheme.required).toEqual([
    'title',
    'heading',
    'excerpt',
  ]);
  for (const response of Object.values(analyze.responses) as { headers: object }[]) {
    expect(response.headers).toHaveProperty('Cache-Control');
  }
});
