import { expect, test } from 'vitest';
import { parseJson } from '../json.ts';

test('JSON文法の全値を保持し不正な入力を拒否する', () => {
  expect(parseJson('{"a":[null,true,2,"s"]}')).toStrictEqual({ a: [null, true, 2, 's'] });
  expect(parseJson('null')).toBeNull();
  expect(() => parseJson('{')).toThrow(SyntaxError);
});
