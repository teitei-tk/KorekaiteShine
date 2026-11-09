import { expect, test, vi } from 'vitest';
import { createMaterialAnalyzer } from '../src/server/openai-material-analyzer';

test('材料を命令と分離し、指定モデルと生成Schemaで分析して結果を読み取る', async () => {
  const markdown = '# 判断\n静的配信を選んだ。';
  const value = { themes: [{ title: '配信方式', heading: '判断', excerpt: '静的配信を選んだ。' }] };
  let sent: Request | undefined;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    sent = new Request(input, init);
    return Response.json({
      id: 'resp_fixture',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'fixture-model',
      error: null,
      incomplete_details: null,
      output: [
        {
          type: 'message',
          id: 'msg_fixture',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }],
        },
      ],
    });
  });
  const analyze = createMaterialAnalyzer({
    apiKey: 'fixture-key',
    model: 'fixture-model',
    fetcher,
  });
  const controller = new AbortController();
  expect(await analyze(markdown, controller.signal)).toEqual(value);
  expect(sent?.url).toBe('https://api.openai.com/v1/responses');
  expect(sent?.headers.get('Authorization')).toBe('Bearer fixture-key');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = await sent!.json();
  expect(body).toMatchObject({
    model: 'fixture-model',
    store: false,
    tools: [],
    tool_choice: 'none',
    input: [{ role: 'user', content: JSON.stringify({ kind: 'experience_markdown', markdown }) }],
    text: {
      format: {
        type: 'json_schema',
        name: 'material_themes',
        strict: true,
        schema: { type: 'object', additionalProperties: false, required: ['themes'] },
      },
    },
  });
  expect(body.instructions).not.toContain(markdown);
  expect(body.text.format.schema.properties.themes.items.required).toEqual([
    'title',
    'heading',
    'excerpt',
  ]);
  expect(body.text.format.schema.properties.themes.items.additionalProperties).toBe(false);
});

test('推論項目を飛ばして完成メッセージを読み、失敗・拒否・設定不足を安全に返す', async () => {
  const message = {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: '{"themes":[]}', annotations: [] }],
  };
  const completed = {
    status: 'completed',
    error: null,
    output: [{ type: 'reasoning', summary: [] }, message],
  };
  const read = createMaterialAnalyzer({
    apiKey: 'fixture-key',
    model: 'fixture-model',
    fetcher: async () => Response.json(completed),
  });
  expect(await read('材料', new AbortController().signal)).toEqual({ themes: [] });
  for (const [status, body] of [
    [401, completed],
    [429, { error: { message: '非公開エラー' } }],
    [503, completed],
    [200, { ...completed, status: 'incomplete' }],
    [
      200,
      { ...completed, output: [{ ...message, content: [{ type: 'refusal', refusal: '拒否' }] }] },
    ],
    [
      200,
      {
        ...completed,
        output: [{ ...message, content: [{ type: 'output_text', text: '不正JSON' }] }],
      },
    ],
    [200, { ...completed, output: [{ ...message, role: 'user' }] }],
    [200, { ...completed, output: [message, message] }],
  ] as const) {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
    const analyze = createMaterialAnalyzer({
      apiKey: 'fixture-key',
      model: 'fixture-model',
      fetcher,
    });
    await expect(analyze('材料', new AbortController().signal)).rejects.toThrow(
      '材料分析AIを利用できません。',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
  const fetcher = vi.fn<typeof fetch>();
  for (const [apiKey, model] of [
    ['', 'fixture-model'],
    ['fixture-key', ''],
  ] as const) {
    await expect(
      createMaterialAnalyzer({ apiKey, model, fetcher })('材料', new AbortController().signal),
    ).rejects.toThrow('材料分析AIを利用できません。');
  }
  expect(fetcher).not.toHaveBeenCalled();
});
