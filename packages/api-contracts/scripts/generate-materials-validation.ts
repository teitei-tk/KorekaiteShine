import type { SchemaObject } from './schema-input.ts';
import { parseObject, objectAt, schemaMap } from './schema-input.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { standaloneValidator } from './standalone-validator.ts';
import { withReachableSchemas } from './reachable-schema.ts';

const directory = new URL('../generated/http/', import.meta.url);
const document = parseObject(await readFile(new URL('openapi.json', directory), 'utf8'));
const responseSchema = aiSchema(
  schemaMap(objectAt(document, 'components').schemas).MaterialAnalysisResult,
);
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
  'MaterialAnalysisRequest',
  'MaterialAnalysisResult',
  'SavedMaterialAnalysis',
  'MaterialErrorBody',
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
await writeFile(
  new URL('materials-validators.mjs', directory),
  standaloneValidator(ajv, validatorExports),
);
await writeFile(
  new URL('materials-validators.d.mts', directory),
  `// 自動生成。編集しないでください。\nimport type { ValidateFunction } from 'ajv';\nimport type { components } from './api';\n${declarations.join('\n')}\n`,
);

// OpenAPIの参照を展開し、外部AIが受け付ける構造化出力の語彙に限定する。
// 文字数などの詳細制約は元のvalidatorで結果受信後にも検証する。
function aiSchema(schema: SchemaObject): object {
  if (typeof schema.$ref === 'string') {
    const prefix = '#/components/schemas/';
    if (!schema.$ref.startsWith(prefix)) {
      throw new Error('未対応の材料Schema参照です。');
    }
    const schemas = objectAt(document, 'components', 'schemas');
    const target = schemas[schema.$ref.slice(prefix.length)];
    if (target === undefined) {
      throw new Error('材料Schema参照先がありません。');
    }
    return aiSchema(objectAt(target));
  }
  return {
    type: schema.type,
    enum: schema.enum,
    required: schema.required,
    additionalProperties: schema.additionalProperties,
    minItems: schema.minItems,
    maxItems: schema.maxItems,
    ...(schema.properties === undefined
      ? {}
      : {
          properties: Object.fromEntries(
            Object.entries(objectAt(schema.properties)).map(([key, value]) => [
              key,
              aiSchema(objectAt(value)),
            ]),
          ),
        }),
    ...(schema.items === undefined ? {} : { items: aiSchema(objectAt(schema.items)) }),
  };
}
await writeFile(
  new URL('material-analysis.schema.json', directory),
  `${JSON.stringify(responseSchema, null, 2)}\n`,
);
