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
  'MaterialAnalysisRequest',
  'MaterialAnalysisResult',
  'SavedMaterialAnalysis',
  'MaterialErrorBody',
]) {
  const name = `validate${model}`;
  ajv.addSchema({
    $id: name,
    ...withReachableSchemas({ $ref: `#/components/schemas/${model}` }, document.components.schemas),
  });
  exports[name] = name;
  declarations.push(`export const ${name}: ValidateFunction<components['schemas']['${model}']>;`);
}
await writeFile(new URL('materials-validators.mjs', directory), standaloneValidator(ajv, exports));
await writeFile(
  new URL('materials-validators.d.mts', directory),
  `// 自動生成。編集しないでください。\nimport type { ValidateFunction } from 'ajv';\nimport type { components } from './api';\n${declarations.join('\n')}\n`,
);

// OpenAPIの参照を展開し、外部AIが受け付ける構造化出力の語彙に限定する。
// 文字数などの詳細制約は元のvalidatorで結果受信後にも検証する。
interface MaterialSchema {
  $ref?: string;
  type?: string;
  enum?: (string | number | boolean | null)[];
  required?: string[];
  additionalProperties?: boolean;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, MaterialSchema>;
  items?: MaterialSchema;
}
function aiSchema(schema: MaterialSchema): MaterialSchema {
  if (typeof schema.$ref === 'string') {
    const prefix = '#/components/schemas/';
    if (!schema.$ref.startsWith(prefix)) {
      throw new Error('未対応の材料Schema参照です。');
    }
    const target = document.components.schemas[schema.$ref.slice(prefix.length)];
    if (!target) {
      throw new Error('材料Schema参照先がありません。');
    }
    return aiSchema(target);
  }
  const result: MaterialSchema = {
    type: schema.type,
    enum: schema.enum,
    required: schema.required,
    additionalProperties: schema.additionalProperties,
    minItems: schema.minItems,
    maxItems: schema.maxItems,
  };
  if (schema.properties) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [name, aiSchema(value)]),
    );
  }
  if (schema.items) {
    result.items = aiSchema(schema.items);
  }
  return result;
}
await writeFile(
  new URL('material-analysis.schema.json', directory),
  `${JSON.stringify(aiSchema(document.components.schemas.MaterialAnalysisResult), null, 2)}\n`,
);
