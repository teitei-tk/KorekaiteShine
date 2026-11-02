import assert from 'node:assert/strict';
import { getInterviews } from '../src/lib/interviews.ts';
import { assertInterviewResponse, interviewCases } from '../tests/contracts/interviews.ts';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4317';
const list = await getInterviews(baseUrl);
assert.deepEqual(
  list.items.map((item) => item.id),
  ['interview-002', 'interview-001'],
);
for (const example of interviewCases) {
  const response = await fetch(`${baseUrl}/api/interviews?${example.query}`);
  await assertInterviewResponse(response, example);
}
const page = await fetch(baseUrl);
assert.equal(page.status, 200);
assert.match(await page.text(), /面接一覧/);
console.log(`HTTP検証成功: 契約${interviewCases.length}件・一覧順序・HTML応答`);
