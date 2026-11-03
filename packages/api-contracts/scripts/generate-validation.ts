import { readFile, writeFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { _ } from 'ajv/dist/compile/codegen/index.js';
import { withReachableSchemas } from './reachable-schema.ts';

const document = JSON.parse(await readFile('generated/http/openapi.json', 'utf8'));
const operation = document.paths['/api/interviews'].get;
const ajv = new Ajv2020({
  strict: false,
  code: { source: true, esm: true, formats: _`formats.fullFormats` },
});
addFormats(ajv);
ajv.addSchema({
  $id: 'response',
  ...withReachableSchemas(
    operation.responses['200'].content['application/json'].schema,
    document.components.schemas,
  ),
});
ajv.addSchema({
  $id: 'badRequest',
  ...withReachableSchemas(
    operation.responses['400'].content['application/json'].schema,
    document.components.schemas,
  ),
});
ajv.addSchema({
  $id: 'query',
  ...withReachableSchemas(
    {
      type: 'object',
      properties: Object.fromEntries(
        operation.parameters.map((parameter: { name: string; schema: object }) => [
          parameter.name,
          parameter.schema,
        ]),
      ),
      additionalProperties: false,
    },
    document.components.schemas,
  ),
});
await writeFile(
  'generated/http/validators.mjs',
  `import formats from 'ajv-formats/dist/formats.js';\n${standaloneCode(ajv, { validateList: 'response', validateBadRequest: 'badRequest', validateQuery: 'query' })}`,
);
await writeFile(
  'generated/http/validators.d.mts',
  `// 自動生成。編集しないでください。\nimport type { ValidateFunction } from 'ajv';\nimport type { components, operations } from './api';\nexport const validateList: ValidateFunction<components['schemas']['InterviewList']>;\nexport const validateBadRequest: ValidateFunction<operations['listInterviews']['responses'][400]['content']['application/json']>;\nexport const validateQuery: ValidateFunction<operations['listInterviews']['parameters']['query']>;\n`,
);
