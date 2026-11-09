import { expect, it } from 'vitest';
import { renewalDue, verifyModelEvidence } from './model.ts';

it.each([0, 3599999, 3600000, 3659999, Number.NaN, -1])(
  '期限前・不正な待機時間を拒否する: %s',
  (elapsed) => {
    expect(renewalDue(elapsed)).toBe(false);
  },
);
it('最大TTLを超える61分後だけを期限更新検証とする', () => {
  expect(renewalDue(3660000)).toBe(true);
});
const request = {
  body: {
    model: 'gpt-6-luna',
    text: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['ok'] } },
          required: ['status'],
          additionalProperties: false,
        },
      },
    },
  },
};
const response = {
  status: 200,
  body:
    'data: ' +
    JSON.stringify({
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"status":"ok"}' }] }],
      },
    }) +
    '\n\n',
};
it('Schema指定とAPI出力、利用量が揃った時だけ成功する', () => {
  expect(verifyModelEvidence(request, response, '{"status":"ok"}')).toEqual({
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
  });
});

it('本文を持たない補助イベントや推論項目を最終出力と混同しない', () => {
  const event = JSON.parse(response.body.slice(5));
  event.response.output.unshift({ type: 'reasoning' });
  const res = { ...response, body: 'data: {}\n' + 'data: ' + JSON.stringify(event) + '\n' };
  expect(verifyModelEvidence(request, res, '{"status":"ok"}')).toEqual({
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
  });
});

it('最終出力項目にtextがなければ成功扱いしない', () => {
  const event = JSON.parse(response.body.slice(5));
  delete event.response.output[0].content[0].text;
  expect(() =>
    verifyModelEvidence(
      request,
      { ...response, body: 'data: ' + JSON.stringify(event) },
      '{"status":"ok"}',
    ),
  ).toThrow();
});
it.each([
  [{ body: { model: 'other' } }, response, '{"status":"ok"}'],
  [request, { ...response, status: 403 }, '{"status":"ok"}'],
  [request, { ...response, body: 'data: {"type":"response.failed"}\n\n' }, '{"status":"ok"}'],
  [
    request,
    { ...response, body: response.body.replace('"input_tokens":10,', '') },
    '{"status":"ok"}',
  ],
  [
    request,
    { ...response, body: response.body.replace('"total_tokens":12', '"total_tokens":-1') },
    '{"status":"ok"}',
  ],
  [request, response, '{"status":"ok","extra":true}'],
  [request, response, '{"status":"failed"}'],
])('権限エラー・Schema違反・利用量欠損を成功扱いしない', (req, res, output) => {
  expect(() => verifyModelEvidence(req, res, output)).toThrow();
});
