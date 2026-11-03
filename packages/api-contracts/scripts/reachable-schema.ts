type JsonValue = string | number | boolean | null | JsonValue[] | JsonSchema;
interface JsonSchema {
  [key: string]: JsonValue;
}

/** 検証対象から参照されるSchemaだけを同梱し、他のAPIの契約を配信しない。 */
export function withReachableSchemas(
  schema: JsonSchema,
  components: Record<string, JsonSchema>,
): JsonSchema {
  const selected = new Map<string, JsonSchema>();
  function visit(value: JsonValue): void {
    if (value === null || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') {
        const match = /^#\/components\/schemas\/([^/]+)$/u.exec(child);
        if (!match) {
          throw new Error(`未対応のSchema参照です: ${child}`);
        }
        const name = match[1]!.replaceAll('~1', '/').replaceAll('~0', '~');
        if (selected.has(name)) {
          continue;
        }
        if (!Object.hasOwn(components, name)) {
          throw new Error(`Schema参照先がありません: ${child}`);
        }
        const target = components[name]!;
        selected.set(name, target);
        visit(target);
      } else {
        visit(child);
      }
    }
  }
  visit(schema);
  return { ...schema, components: { schemas: Object.fromEntries(selected) } };
}
