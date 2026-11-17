import { expect, test } from 'vitest';
import {
  objectAt,
  objectArray,
  parseObject,
  schemaMap,
  stringValue,
} from '../scripts/schema-input.ts';

test('生成入力のオブジェクトと参照経路を構造検査し、原本の項目を保持する', () => {
  const document = parseObject(
    '{"components":{"schemas":{"Item":{"type":"string","maxLength":10}}},"extension":true}',
  );
  expect(objectAt(document, 'components', 'schemas', 'Item')).toEqual({
    type: 'string',
    maxLength: 10,
  });
  expect(document.extension).toBe(true);
  expect(schemaMap(objectAt(document, 'components').schemas).Item).toEqual({
    type: 'string',
    maxLength: 10,
  });
});

test('オブジェクトを要求する位置のnull・配列・値・欠落を拒否する', () => {
  for (const value of [null, [], true, 0, 'schema', undefined]) {
    expect(() => objectAt(value)).toThrow(TypeError);
  }
  expect(() => objectAt({}, 'missing')).toThrow(TypeError);
  expect(() => parseObject('{')).toThrow(SyntaxError);
  expect(() => schemaMap({ Item: false })).toThrow(TypeError);
});

test('パラメータ配列の各項目と名前を検査する', () => {
  expect(objectArray([{ name: 'limit' }])).toEqual([{ name: 'limit' }]);
  expect(stringValue('limit')).toBe('limit');
  expect(() => objectArray({})).toThrow(TypeError);
  expect(() => objectArray([null])).toThrow(TypeError);
  expect(() => stringValue(1)).toThrow(TypeError);
});
