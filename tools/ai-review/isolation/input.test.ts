import { expect, it } from 'vitest';
import { identityField, isolationInput, positiveInteger, readObject, textField } from './input.ts';

const input = {
  expectedUid: 1000,
  protectedFiles: [],
  readOnlyDirectories: [],
  parentPid: 2,
  port: 3000,
};
it('隔離入力の必須値と省略可能値を正規化する', () => {
  expect(isolationInput(JSON.stringify(input))).toEqual({ ...input, env: process.env });
  expect(
    isolationInput(
      JSON.stringify({
        ...input,
        parentPidNamespace: 'pid:[1]',
        readOnlyFiles: ['a'],
        protectedSockets: ['b'],
        protectedProcesses: [3],
      }),
    ),
  ).toMatchObject({
    parentPidNamespace: 'pid:[1]',
    readOnlyFiles: ['a'],
    protectedSockets: ['b'],
    protectedProcesses: [3],
  });
});
it.each([null, [], 1])('オブジェクトでない入力を拒否する: %s', (value) => {
  expect(() => readObject(JSON.stringify(value))).toThrow('invalid fixture JSON object');
  expect(() => identityField(value)).toThrow('invalid fixture process identity');
});
it('文字列以外を拒否する', () => expect(() => textField(null)).toThrow('invalid fixture string'));
it.each([null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  '正の安全な整数以外を拒否する: %s',
  (value) => expect(() => positiveInteger(value)).toThrow('invalid fixture integer'),
);
it.each([null, [2]])('文字列配列以外を拒否する: %s', (protectedFiles) =>
  expect(() => isolationInput(JSON.stringify({ ...input, protectedFiles }))).toThrow(
    'invalid fixture string list',
  ),
);
it.each([null, '3', ['3'], [1.5], [0]])(
  '不正な保護プロセス一覧を拒否する: %s',
  (protectedProcesses) =>
    expect(() => isolationInput(JSON.stringify({ ...input, protectedProcesses }))).toThrow(
      'invalid fixture process list',
    ),
);
it('範囲外のポートを拒否する', () =>
  expect(() => isolationInput(JSON.stringify({ ...input, port: 65_536 }))).toThrow(
    'invalid fixture port',
  ));
