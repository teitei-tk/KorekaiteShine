import assert from 'node:assert/strict';
import test from 'node:test';

test('TypeScript 7系のツール環境でもOpenAPIから必須プロパティの型を生成できる', async () => {
  const { default: openapiTS, astToString } = await import('openapi-typescript');
  const output = astToString(
    await openapiTS({
      openapi: '3.1.0',
      info: { title: '互換性検証', version: '1.0.0' },
      paths: {},
      components: {
        schemas: {
          Interview: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
        },
      },
    }),
  );
  assert.match(output, /id: string;/);
});
