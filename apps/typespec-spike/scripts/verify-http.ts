import assert from 'node:assert/strict';
import { getInterviews } from '../src/lib/interviews.ts';
import { validateBadRequest, validateList } from '../generated/validators.mjs';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4317';
const list = await getInterviews(baseUrl);
assert.deepEqual(
  list.items.map((item) => item.id),
  ['interview-002', 'interview-001'],
);
const limited = await fetch(`${baseUrl}/api/interviews?limit=1`);
assert.equal(limited.status, 200);
const payload = await limited.json();
assert.ok(validateList(payload));
assert.equal(payload.items.length, 1);
for (const query of [
  'limit=0',
  'limit=21',
  'limit=abc',
  'limit=1.5',
  'limit=',
  'limit=1&limit=2',
]) {
  const response = await fetch(`${baseUrl}/api/interviews?${query}`);
  assert.equal(response.status, 400, query);
  const error = await response.json();
  assert.ok(validateBadRequest(error));
  assert.deepEqual(error, {
    code: 'INVALID_QUERY',
    message: 'limitは1〜20の整数で指定してください。',
  });
}
const page = await fetch(baseUrl);
assert.equal(page.status, 200);
assert.match(await page.text(), /面接一覧/);
console.log('HTTP検証成功: 一覧・件数制限・不正入力6件・HTML応答');
