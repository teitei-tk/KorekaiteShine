import { expect, test } from 'vitest';
import { analyzeMaterial } from '../../../apps/web/src/application/analyze-material.ts';
import { preparationMaterials } from '../bombadil/preparation-materials.ts';

test('正常系の探索材料はPR用模擬AIの根拠を含み、境界入力も指定のバイト数になる', async () => {
  // PR用のapi.materials.analyze.tsはこの固定結果を返す。
  const result = { themes: [{ title: '構成', heading: '本文', excerpt: '架空の経験' }] };
  for (const markdown of [
    preparationMaterials.normal,
    preparationMaterials.edited,
    preparationMaterials.atLimit,
  ]) {
    expect(
      await analyzeMaterial({ markdown, confirmed: true }, { analyze: async () => result }),
    ).toEqual({ ok: true, value: result });
  }
  expect(new TextEncoder().encode(preparationMaterials.atLimit).byteLength).toBe(32_768);
  expect(new TextEncoder().encode(preparationMaterials.overLimit).byteLength).toBe(32_769);
});
