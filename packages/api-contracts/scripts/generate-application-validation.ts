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
for (const model of [
  'LocalSession',
  'ApplicationError',
  'InterviewHistory',
  'InterviewDetail',
  'RetryEvaluationRequest',
  'RetryEvaluationAccepted',
]) {
  const name = `validate${model}`;
  ajv.addSchema({
    $id: name,
    ...withReachableSchemas({ $ref: `#/components/schemas/${model}` }, document.components.schemas),
  });
  exports[name] = name;
  declarations.push(`export const ${name}: ValidateFunction<components['schemas']['${model}']>;`);
}
const parameters = document.paths['/api/interview-history'].get.parameters
  .map((parameter: { $ref?: string; in?: string; name?: string; schema?: object }) => {
    if (!parameter.$ref) {
      return parameter;
    }
    const prefix = '#/components/parameters/';
    if (!parameter.$ref.startsWith(prefix)) {
      throw new Error('未対応の引数参照です。');
    }
    const name = parameter.$ref.slice(prefix.length).replaceAll('~1', '/').replaceAll('~0', '~');
    const resolved = document.components.parameters[name];
    if (!resolved) {
      throw new Error('引数の参照先がありません。');
    }
    return resolved;
  })
  .filter((parameter: { in: string }) => parameter.in === 'query');
const queryName = 'validateInterviewHistoryQuery';
ajv.addSchema({
  $id: queryName,
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(
    parameters.map((parameter: { name: string; schema: object }) => [
      parameter.name,
      parameter.schema,
    ]),
  ),
  required: parameters
    .filter((parameter: { required?: boolean }) => parameter.required)
    .map((parameter: { name: string }) => parameter.name),
});
exports[queryName] = queryName;
declarations.push(
  `export const ${queryName}: ValidateFunction<NonNullable<operations['getInterviewHistory']['parameters']['query']>>;`,
);
const idParameter = document.paths['/api/interviews/{interviewId}'].get.parameters.find(
  (parameter: { in: string; name: string }) =>
    parameter.in === 'path' && parameter.name === 'interviewId',
);
if (!idParameter?.schema) {
  throw new Error('面接IDの契約がありません。');
}
ajv.addSchema({ $id: 'validateInterviewId', ...idParameter.schema });
exports.validateInterviewId = 'validateInterviewId';
declarations.push(
  `export const validateInterviewId: ValidateFunction<operations['getInterviewDetail']['parameters']['path']['interviewId']>;`,
);
await writeFile(
  new URL('application-validators.mjs', directory),
  standaloneValidator(ajv, exports),
);
await writeFile(
  new URL('application-validators.d.mts', directory),
  `// 自動生成。編集しないでください。\nimport type { ValidateFunction } from 'ajv';\nimport type { components, operations } from './api';\n${declarations.join('\n')}\n`,
);
