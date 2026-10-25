import { expect, it } from 'vitest';
import { requestStructuredReview } from './review.ts';
import type { BillingHooks } from './budget.ts';
import { ReviewFailure } from './failure.ts';
const schema = { type: 'object', properties: {}, additionalProperties: false };
const calls: string[] = [];
const hooks: BillingHooks = {
  async reserve(input, hash) {
    expect(input).toBe(100);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    calls.push('reserved');
  },
  async settle(usage) {
    expect(usage).toEqual({ input: 100, cached: 20, written: 30, output: 40, total: 140 });
    calls.push('settled');
  },
};
function mock(text = '{}', status = 'completed'): typeof fetch {
  let counted: object;
  return async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith('/input_tokens')) {
      counted = body;
      expect(Object.keys(body).sort()).toEqual(['input', 'model', 'reasoning', 'text', 'tools']);
      expect(body.text.format.schema).toEqual(schema);
      return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
    }
    expect(calls).toContain('reserved');
    expect(body).toMatchObject(counted);
    expect(Object.keys(counted!).sort()).toEqual(['input', 'model', 'reasoning', 'text', 'tools']);
    expect(body.service_tier).toBe('default');
    expect(body.prompt_cache_options).toEqual({ mode: 'implicit', ttl: '30m' });
    return Response.json({
      id: 'resp_test',
      object: 'response',
      model: 'gpt-6-luna',
      service_tier: 'default',
      status,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
        output_tokens: 40,
        total_tokens: 140,
      },
    });
  };
}
it('同じ要求を計数し、予約後に生成し、結果検証前にusageを精算する', async () => {
  calls.length = 0;
  await requestStructuredReview(
    'token',
    'prompt',
    (value) => {
      expect(calls).toEqual(['reserved', 'settled']);
      return value;
    },
    mock(),
    schema,
    hooks,
  );
});
it.each([
  ['not-json', 'completed'],
  ['{}', 'incomplete'],
])('不正JSON・未完了でも先に費用を記録する', async (text, status) => {
  calls.length = 0;
  await expect(
    requestStructuredReview('token', 'prompt', (x) => x, mock(text, status), schema, hooks),
  ).rejects.toThrow();
  expect(calls).toEqual(['reserved', 'settled']);
});
it('予算不足なら生成APIを呼ばない', async () => {
  let requests = 0;
  await expect(
    requestStructuredReview(
      'token',
      'prompt',
      (x) => x,
      async () => {
        requests++;
        return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
      },
      schema,
      {
        ...hooks,
        async reserve() {
          throw new ReviewFailure('COST_BUDGET_EXCEEDED', '予算');
        },
      },
    ),
  ).rejects.toMatchObject({ reason: 'COST_BUDGET_EXCEEDED' });
  expect(requests).toBe(1);
});
it('usageなし・通信失敗では精算しない', async () => {
  for (const broken of ['usage', 'network']) {
    calls.length = 0;
    await expect(
      requestStructuredReview(
        'token',
        'prompt',
        (x) => x,
        async (url) => {
          if (String(url).endsWith('/input_tokens'))
            return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
          if (broken === 'network') throw Error('SECRET');
          return Response.json({ model: 'gpt-6-luna', service_tier: 'default', output: [] });
        },
        schema,
        hooks,
      ),
    ).rejects.toThrow();
    expect(calls).toEqual(['reserved']);
  }
});
it('料金区分が違う応答を既知の単価で精算しない', async () => {
  calls.length = 0;
  await expect(
    requestStructuredReview(
      'token',
      'prompt',
      (x) => x,
      async (url) => {
        if (String(url).endsWith('/input_tokens'))
          return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
        return Response.json({
          model: 'gpt-6-luna',
          service_tier: 'priority',
          output: [],
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
            output_tokens: 40,
            total_tokens: 140,
          },
        });
      },
      schema,
      hooks,
    ),
  ).rejects.toMatchObject({ reason: 'USAGE_INVALID' });
  expect(calls).toEqual(['reserved']);
});
