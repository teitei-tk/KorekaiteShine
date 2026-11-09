import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('生成validatorをrequireなしのESMで読み込み、絵文字をUnicode文字数で検証する', () => {
  const materials = new URL('../generated/http/materials-validators.mjs', import.meta.url).href;
  const evaluation = new URL('../generated/http/evaluation-validators.mjs', import.meta.url).href;
  const interviews = new URL('../generated/http/interviews-validators.mjs', import.meta.url).href;
  const events = new URL('../generated/events/validators.mjs', import.meta.url).href;
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { validateMaterialAnalysisResult: validate } = await import(${JSON.stringify(materials)});
    await import(${JSON.stringify(evaluation)});
    await import(${JSON.stringify(interviews)});
    await import(${JSON.stringify(events)});
    const theme = { title: '😀'.repeat(200), heading: '本文', excerpt: '架空の経験' };
    console.log(JSON.stringify([validate({ themes: [theme] }), validate({ themes: [{ ...theme, title: '😀'.repeat(201) }] })]));
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(JSON.parse(result)).toEqual([true, false]);
});

test('Workerに変換できないCommonJS helperを含むvalidatorの生成を拒否する', async () => {
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const { default: addFormats } = await import('ajv-formats');
  const { standaloneValidator } = await import('../scripts/standalone-validator.ts');
  const ajv = new Ajv2020({ code: { source: true, esm: true } });
  addFormats(ajv);
  ajv.addSchema({ $id: 'date-time', type: 'string', format: 'date-time' });
  expect(() => standaloneValidator(ajv, { validate: 'date-time' })).toThrow('未対応のCommonJS参照');
});
