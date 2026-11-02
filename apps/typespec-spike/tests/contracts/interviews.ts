import assert from 'node:assert/strict';
import { validateBadRequest, validateList } from '../../generated/validators.mjs';

// 変換前のHTTP表記を保持する。期待値をハンドラーやスキーマから計算しない。
export const interviewCases: { query: string; status: 200 | 400; count?: number }[] = [
  { query: '', status: 200, count: 2 },
  { query: 'limit=1', status: 200, count: 1 },
  { query: 'limit=20', status: 200, count: 2 },
  { query: 'limit=01', status: 200, count: 1 },
  { query: 'limit=%31', status: 200, count: 1 },
  ...[
    'limit=0',
    'limit=21',
    'limit=-1',
    'limit=1.5',
    'limit=abc',
    'limit=',
    'limit=1&limit=2',
    'limit=1&limit=1',
    'limit=1e1',
    'limit=0x10',
    'limit=0b10',
    'limit=0o10',
    'limit=1.0',
    'limit=%201',
    'limit=1%20',
    'limit=%2B1',
    'limit=+1',
    'limit=%091',
    'limit=1%0A',
    'limit=%EF%BC%91',
    'limit=%2531',
    'other=1',
    'limit=1&other=1',
  ].map((query): { query: string; status: 400 } => ({ query, status: 400 })),
];

export const interviewResponseValidators = {
  200: validateList,
  400: validateBadRequest,
};

export async function assertInterviewResponse(
  response: Response,
  expected: (typeof interviewCases)[number],
): Promise<void> {
  assert.equal(response.status, expected.status, expected.query);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/u);
  const body = await response.json();
  if (expected.status === 200) {
    assert.ok(interviewResponseValidators[200](body), JSON.stringify(validateList.errors));
    assert.equal(body.items.length, expected.count, expected.query);
  } else {
    assert.ok(interviewResponseValidators[400](body), JSON.stringify(validateBadRequest.errors));
  }
}
