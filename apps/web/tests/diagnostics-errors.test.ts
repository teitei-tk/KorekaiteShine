import { expect, test } from 'vitest';
import { bodyValidationDetails } from '../src/diagnostics/errors';

test('検証エラー未指定なら詳細は空配列になる', () => {
  expect(bodyValidationDetails(undefined)).toEqual([]);
});

test('requiredの入力項目を/scenarioとREQUIREDへ変換する', () => {
  expect(
    bodyValidationDetails([
      {
        keyword: 'required',
        instancePath: '',
        schemaPath: '#/required',
        params: { missingProperty: 'scenario' },
      },
    ]),
  ).toEqual([
    {
      location: 'body',
      path: '/scenario',
      code: 'REQUIRED',
      message: '入力項目を確認してください。',
    },
  ]);
});

test('additionalPropertiesの入力項目を/extraとUNRECOGNIZED_FIELDへ変換する', () => {
  expect(
    bodyValidationDetails([
      {
        keyword: 'additionalProperties',
        instancePath: '',
        schemaPath: '#/additionalProperties',
        params: { additionalProperty: 'extra' },
      },
    ]),
  ).toEqual([
    {
      location: 'body',
      path: '/extra',
      code: 'UNRECOGNIZED_FIELD',
      message: '入力項目を確認してください。',
    },
  ]);
});

test('formatの入力項目を本文全体とINVALID_FORMATへ変換する', () => {
  expect(
    bodyValidationDetails([
      { keyword: 'format', instancePath: '', schemaPath: '#/format', params: { format: 'uuid' } },
    ]),
  ).toEqual([
    { location: 'body', path: '', code: 'INVALID_FORMAT', message: '入力項目を確認してください。' },
  ]);
});

test('requiredの入力項目を/a~0~1bとREQUIREDへ変換する', () => {
  expect(
    bodyValidationDetails([
      {
        keyword: 'required',
        instancePath: '',
        schemaPath: '#/required',
        params: { missingProperty: 'a~/b' },
      },
    ]),
  ).toEqual([
    {
      location: 'body',
      path: '/a~0~1b',
      code: 'REQUIRED',
      message: '入力項目を確認してください。',
    },
  ]);
});
