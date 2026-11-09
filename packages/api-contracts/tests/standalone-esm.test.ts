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
