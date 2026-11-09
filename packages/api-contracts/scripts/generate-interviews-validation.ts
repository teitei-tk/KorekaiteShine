import { readFile, writeFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { standaloneValidator } from './standalone-validator.ts';
import { withReachableSchemas } from './reachable-schema.ts';

const directory = new URL('../generated/http/', import.meta.url);
const document = JSON.parse(await readFile(new URL('openapi.json', directory), 'utf8'));
const ajv = new Ajv2020({
  strict: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  code: { source: true, esm: true },
});
const exports: Record<string, string> = {};
const declarations: string[] = [];
for (const model of ['CreateInterviewRequest', 'InterviewSession', 'InterviewErrorBody']) {
  const name = `validate${model}`;
  ajv.addSchema({
    $id: name,
    ...withReachableSchemas({ $ref: `#/components/schemas/${model}` }, document.components.schemas),
  });
  exports[name] = name;
  declarations.push(`export const ${name}: ValidateFunction<components['schemas']['${model}']>;`);
}
await writeFile(new URL('interviews-validators.mjs', directory), standaloneValidator(ajv, exports));
await writeFile(
  new URL('interviews-validators.d.mts', directory),
  `// 自動生成。編集しないでください。\nimport type { ValidateFunction } from 'ajv';\nimport type { components } from './api';\n${declarations.join('\n')}\n`,
);
