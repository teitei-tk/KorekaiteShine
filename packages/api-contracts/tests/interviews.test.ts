import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('面接開始は保存済み候補の選択だけを受け付け、再送用IDと型付き結果を持つ', async () => {
  const document = JSON.parse(
    await readFile(new URL('../generated/http/openapi.json', import.meta.url), 'utf8'),
  );
  expect(document.paths['/api/interviews'].post).toBeDefined();
  const { validateCreateInterviewRequest, validateInterviewSession, validateInterviewErrorBody } =
    await import('../generated/http/interviews-validators.mjs');
  const input = {
    interviewId: 'interview-1',
    analysisId: 'analysis-1',
    themeIndex: 0,
    background: '',
  };
  expect(validateCreateInterviewRequest(input)).toBe(true);
  for (const invalid of [
    { ...input, themeIndex: -1 },
    { ...input, themeIndex: 0.5 },
    { ...input, themeIndex: 5 },
    { ...input, background: 'a'.repeat(4001) },
    { ...input, interviewId: '../escape' },
    { ...input, excerpt: '任意の内容' },
    { ...input, model: 'arbitrary' },
    null,
  ]) {
    expect(validateCreateInterviewRequest(invalid)).toBe(false);
  }
  expect(
    validateInterviewSession({
      interviewId: 'interview-1',
      status: 'ready',
      theme: '構成',
      createdAt: 0,
      activeMs: 0,
    }),
  ).toBe(true);
  expect(
    validateInterviewSession({
      interviewId: 'interview-1',
      status: 'invented',
      theme: '構成',
      createdAt: 0,
      activeMs: 0,
    }),
  ).toBe(false);
  expect(
    validateInterviewErrorBody({ error: { code: 'INTERVIEW_CONFLICT', message: '進行中です。' } }),
  ).toBe(true);
});
