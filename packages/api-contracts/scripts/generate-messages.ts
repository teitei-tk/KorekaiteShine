import { readFile, writeFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { compile } from 'json-schema-to-typescript';

const directory = new URL('../generated/messages/', import.meta.url);
const schema = JSON.parse(await readFile(new URL('JobNotification.json', directory), 'utf8'));
const ajv = new Ajv2020({
  strict: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  code: { source: true, esm: true },
});
ajv.addSchema(schema, 'JobNotification');
await writeFile(
  new URL('types.d.ts', directory),
  await compile(schema, 'JobNotification', {
    bannerComment: '// 自動生成。編集しないでください。',
    customName: (definition) => definition.$id?.replace(/\.json$/u, ''),
  }),
);
await writeFile(
  new URL('validators.mjs', directory),
  standaloneCode(ajv, {
    validateJobNotification: 'JobNotification',
  }),
);
await writeFile(
  new URL('validators.d.mts', directory),
  `// 自動生成。編集しないでください。
import type { ValidateFunction } from 'ajv';
import type { JobNotification } from './types';
export const validateJobNotification: ValidateFunction<JobNotification>;
`,
);
