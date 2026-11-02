import { expect, test } from 'vitest';
import { listInterviews } from '../src/server/interviews.ts';
import { readFile } from 'node:fs/promises';
import {
  assertInterviewResponse,
  interviewCases,
  interviewResponseValidators,
} from './contracts/interviews.ts';

test('面接一覧を新しい順に取得し、limitで件数を制限できる', async () => {
  const response = listInterviews(new Request('http://localhost/api/interviews?limit=1'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    items: [
      {
        id: 'interview-002',
        theme: '評価処理をQueueへ分離した判断',
        startedAt: '2026-10-30T01:00:00Z',
        materialKind: 'code',
        durationSeconds: 900,
        evaluationStatus: 'waiting',
      },
    ],
  });
});

test.each(interviewCases)('HTTP契約: $query → $status', async (example) => {
  const response = listInterviews(new Request(`http://localhost/api/interviews?${example.query}`));
  await assertInterviewResponse(response, example);
});

test('OpenAPIに定義したすべての応答に検証コードと実行ケースがある', async () => {
  const document = JSON.parse(
    await readFile(new URL('../generated/openapi.json', import.meta.url), 'utf8'),
  );
  const statuses = Object.keys(document.paths['/api/interviews'].get.responses).sort();
  expect(Object.keys(interviewResponseValidators).sort()).toEqual(statuses);
  expect([...new Set(interviewCases.map((example) => String(example.status)))].sort()).toEqual(
    statuses,
  );
});
