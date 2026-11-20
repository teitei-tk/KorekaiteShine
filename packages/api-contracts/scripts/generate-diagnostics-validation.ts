import { parseObject, objectAt, objectArray } from './schema-input.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { _ } from 'ajv/dist/compile/codegen/index.js';

const directory = new URL('../generated/http/', import.meta.url);
const document = parseObject(await readFile(new URL('openapi.json', directory), 'utf8'));
const operations = {
  startCheckJob: objectAt(document, 'paths', '/api/diagnostics/check-jobs', 'post'),
  getCheckJob: objectAt(document, 'paths', '/api/diagnostics/check-jobs/{jobId}', 'get'),
};
const ajv = new Ajv2020({
  strict: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  code: { source: true, esm: true, formats: _`formats.fullFormats` },
});
addFormats(ajv);
const validatorExports: Record<string, string> = {};
const declarations: string[] = [];
function add(name: string, schema: object, type: string): void {
  ajv.addSchema({ $id: name, components: objectAt(document, 'components'), ...schema });
  validatorExports[name] = name;
  declarations.push(`export const ${name}: ValidateFunction<${type}>;`);
}
add(
  'validateCheckStart',
  objectAt(operations.startCheckJob, 'requestBody', 'content', 'application/json', 'schema'),
  "operations['startCheckJob']['requestBody']['content']['application/json']",
);
for (const [name, operationId, status] of [
  ['validateCheckAccepted', 'startCheckJob', 202],
  ['validateCheckStatus', 'getCheckJob', 200],
  ['validateCheckValidationError', 'startCheckJob', 400],
  ['validateCheckNotFound', 'getCheckJob', 404],
  ['validateCheckConflict', 'startCheckJob', 409],
  ['validateCheckUnsupportedMediaType', 'startCheckJob', 415],
  ['validateCheckInternalError', 'startCheckJob', 500],
  ['validateCheckUnavailable', 'startCheckJob', 503],
] as const) {
  add(
    name,
    objectAt(
      operations[operationId],
      'responses',
      String(status),
      'content',
      'application/json',
      'schema',
    ),
    `operations['${operationId}']['responses'][${status}]['content']['application/json']`,
  );
}
for (const [name, operationId, location, parameter] of [
  ['validateCheckIdempotencyKey', 'startCheckJob', 'header', 'Idempotency-Key'],
  ['validateCheckJobId', 'getCheckJob', 'path', 'jobId'],
] as const) {
  const entry = objectArray(operations[operationId].parameters).find(
    (candidate) => candidate.in === location && candidate.name === parameter,
  );
  if (!entry) {
    throw new Error(`契約に${parameter}がありません。`);
  }
  add(
    name,
    objectAt(entry.schema),
    `operations['${operationId}']['parameters']['${location}']['${parameter}']`,
  );
}
await writeFile(
  new URL('diagnostics-validators.mjs', directory),
  `import formats from 'ajv-formats/dist/formats.js';\n${standaloneCode(ajv, validatorExports)}`,
);
await writeFile(
  new URL('diagnostics-validators.d.mts', directory),
  `// 自動生成。編集しないでください。
import type { ValidateFunction } from 'ajv';
import type { operations } from './api';
${declarations.join('\n')}
`,
);
