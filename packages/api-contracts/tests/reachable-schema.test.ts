import { expect, test } from 'vitest';
import { withReachableSchemas } from '../scripts/reachable-schema';

test('参照されるAとBだけを抽出し未参照Cを含めない', () => {
  const input = { $ref: '#/components/schemas/A' };
  const components = {
    A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
    B: { type: 'string' },
    C: { type: 'number' },
  };
  expect(withReachableSchemas(input, components)).toEqual({
    $ref: '#/components/schemas/A',
    components: {
      schemas: {
        A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
        B: { type: 'string' },
      },
    },
  });
});

test('循環するAとBの参照を各一度だけ収録して終了する', () => {
  const components = {
    A: { $ref: '#/components/schemas/B' },
    B: { $ref: '#/components/schemas/A' },
  };
  expect(withReachableSchemas({ $ref: '#/components/schemas/A' }, components)).toEqual({
    $ref: '#/components/schemas/A',
    components: {
      schemas: { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' } },
    },
  });
});

test('参照先が存在しないSchemaを拒否する', () => {
  expect(() => withReachableSchemas({ $ref: '#/components/schemas/Missing' }, {})).toThrow(
    'Schema参照先がありません',
  );
});

test('外部URLのSchema参照を拒否する', () => {
  expect(() => withReachableSchemas({ $ref: 'https://example.com/schema.json' }, {})).toThrow(
    '未対応のSchema参照です',
  );
});

test('配列内のSchema参照を抽出する', () => {
  expect(
    withReachableSchemas(
      { anyOf: [{ type: 'null' }, { $ref: '#/components/schemas/A' }] },
      { A: { type: 'string' } },
    ),
  ).toEqual({
    anyOf: [{ type: 'null' }, { $ref: '#/components/schemas/A' }],
    components: { schemas: { A: { type: 'string' } } },
  });
});

test('JSON PointerでエスケープされたSchema名を解決する', () => {
  expect(
    withReachableSchemas({ $ref: '#/components/schemas/a~0~1b' }, { 'a~/b': { type: 'boolean' } }),
  ).toEqual({
    $ref: '#/components/schemas/a~0~1b',
    components: { schemas: { 'a~/b': { type: 'boolean' } } },
  });
});

test('抽出時に入力Schemaや参照元を変更しない', () => {
  const schema = { $ref: '#/components/schemas/A' };
  const components = { A: { type: 'string' }, B: { type: 'number' } };
  const beforeSchema = structuredClone(schema);
  const beforeComponents = structuredClone(components);
  withReachableSchemas(schema, components);
  expect(schema).toEqual(beforeSchema);
  expect(components).toEqual(beforeComponents);
});
