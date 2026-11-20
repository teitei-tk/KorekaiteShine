import { parseObject, objectAt, objectArray, schemaMap, stringValue } from './schema-input.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { standaloneValidator } from './standalone-validator.ts';
import { withReachableSchemas } from './reachable-schema.ts';

const directory = new URL('../generated/http/', import.meta.url);
const document = parseObject(await readFile(new URL('openapi.json', directory), 'utf8'));
const ajv = new Ajv2020({
  strict: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  code: { source: true, esm: true },
});
const validatorExports: Record<string, string> = {};
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
    ...withReachableSchemas(
      { $ref: `#/components/schemas/${model}` },
      schemaMap(objectAt(document, 'components').schemas),
    ),
  });
  validatorExports[name] = name;
  declarations.push(`export const ${name}: ValidateFunction<components['schemas']['${model}']>;`);
}
const parameters = objectArray(
  objectAt(document, 'paths', '/api/interview-history', 'get').parameters,
)
  .map((parameter) => {
    if (parameter.$ref === undefined) {
      return parameter;
    }
    const reference = stringValue(parameter.$ref);
    const prefix = '#/components/parameters/';
    if (!reference.startsWith(prefix)) {
      throw new Error('未対応の引数参照です。');
    }
    const name = reference.slice(prefix.length).replaceAll('~1', '/').replaceAll('~0', '~');
    const resolved = objectAt(document, 'components', 'parameters')[name];
    if (resolved === undefined) {
      throw new Error('引数の参照先がありません。');
    }
    return objectAt(resolved);
  })
  .filter((parameter) => parameter.in === 'query');
const queryName = 'validateInterviewHistoryQuery';
ajv.addSchema({
  $id: queryName,
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(
    parameters.map((parameter) => [stringValue(parameter.name), objectAt(parameter.schema)]),
  ),
  required: parameters
    .filter((parameter) => parameter.required === true)
    .map((parameter) => stringValue(parameter.name)),
});
validatorExports[queryName] = queryName;
declarations.push(
  `export const ${queryName}: ValidateFunction<NonNullable<operations['getInterviewHistory']['parameters']['query']>>;`,
);
const idParameter = objectArray(
  objectAt(document, 'paths', '/api/interviews/{interviewId}', 'get').parameters,
).find((parameter) => parameter.in === 'path' && parameter.name === 'interviewId');
if (idParameter?.schema === undefined) {
  throw new Error('面接IDの契約がありません。');
}
ajv.addSchema({ $id: 'validateInterviewId', ...objectAt(idParameter.schema) });
validatorExports.validateInterviewId = 'validateInterviewId';
declarations.push(
  `export const validateInterviewId: ValidateFunction<operations['getInterviewDetail']['parameters']['path']['interviewId']>;`,
);
await writeFile(
  new URL('application-validators.mjs', directory),
  standaloneValidator(ajv, validatorExports),
);
await writeFile(
  new URL('application-validators.d.mts', directory),
  `// 自動生成。編集しないでください。\nimport type { ValidateFunction } from 'ajv';\nimport type { components, operations } from './api';\n${declarations.join('\n')}\n`,
);
