import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { standaloneValidator } from './standalone-validator.ts';
import { compile } from 'json-schema-to-typescript';

const directory = new URL('../generated/events/', import.meta.url);
const ajv = new Ajv2020({
  strict: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  code: { source: true, esm: true },
});
for (const name of await readdir(directory)) {
  if (name.endsWith('.json')) {
    ajv.addSchema(JSON.parse(await readFile(new URL(name, directory), 'utf8')), name);
  }
}
const exports: Record<string, string> = {};
const declarations: string[] = [];
for (const name of [
  'LiveStartEvent',
  'LiveServerEvent',
  'LiveClientEvent',
  'InterviewClientEvent',
  'InterviewServerEvent',
]) {
  const schema = JSON.parse(await readFile(new URL(`${name}.json`, directory), 'utf8'));
  await writeFile(
    new URL(`${name}.d.ts`, directory),
    await compile(schema, name, {
      cwd: fileURLToPath(directory),
      bannerComment: '// 自動生成。編集しないでください。',
      customName: (definition) => definition.$id?.replace(/\.json$/u, ''),
    }),
  );
  exports[`validate${name}`] = `${name}.json`;
  declarations.push(
    `import type { ${name} } from './${name}';\nexport const validate${name}: ValidateFunction<${name}>;`,
  );
}
await writeFile(new URL('validators.mjs', directory), standaloneValidator(ajv, exports));
await writeFile(
  new URL('validators.d.mts', directory),
  `// 自動生成。編集しないでください。\nimport type { ValidateFunction } from 'ajv';\n${declarations.join('\n')}\n`,
);
