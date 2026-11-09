import { expect, it } from 'vitest';
import {
  detail,
  validDetail,
  validDiagnostic,
  renderDiagnostic,
  type Diagnostic,
} from './diagnostics.ts';

function scoped(): Diagnostic {
  return {
    ...detail('MISSING_CONTEXT', ['CONTRACT']),
    scope: {
      kind: 'boundary',
      sourceCount: 1,
      obligationCount: 1,
      sources: [{ id: 'a'.repeat(64), start: 2, end: 4, revisions: ['base', 'head'] }],
      obligations: ['b'.repeat(16)],
    },
  };
}

it('診断に作業種別がないscopeを受け付けない', () => {
  const value = scoped();
  expect(validDiagnostic({ ...value, scope: { ...value.scope, kind: undefined } })).toBe(false);
});

it('資料の終了行が開始行より前なら診断表示を拒否する', () => {
  const value = scoped();
  value.scope!.sources[0].end = 1;
  expect(validDiagnostic(value)).toBe(false);
  expect(() => renderDiagnostic(value)).toThrow('診断の形式が不正');
});

it('不足分類の重複は診断作成時に拒否する', () => {
  expect(() => detail('MISSING_CONTEXT', ['CONTRACT', 'CONTRACT'])).toThrow('診断分類が不正');
  expect(validDetail(null)).toBe(false);
});

it('scopeの件数と表示サンプルが一致しなければ受理しない', () => {
  const value = scoped();
  value.scope!.sourceCount = 2;
  expect(validDiagnostic(value)).toBe(false);
});

it('固定IDと行範囲で構成した診断を受理し資料・確認対象を表示する', () => {
  const value = scoped();
  expect(validDiagnostic(value)).toBe(true);
  const rendered = renderDiagnostic(value);
  expect(rendered).toContain('資料: 1/1件、確認対象: 1/1件');
  expect(rendered).toContain('行: 2-4、版: base, head');
  expect(rendered).toContain('確認対象ID: ' + 'b'.repeat(16));
});
