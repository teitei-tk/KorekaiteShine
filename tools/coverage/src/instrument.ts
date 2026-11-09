import { createInstrumenter } from '@vitest/istanbul-lib-instrument';
import { transformSync } from 'rolldown/utils';

/** 型除去後の同じソースへ計測位置を割り当て、実行前の分母も返す。 */
export function instrumentSource(path: string, source: string) {
  const transformed = transformSync(path, source, { sourcemap: true, jsx: 'preserve' });
  if (transformed.errors.length > 0) {
    throw new AggregateError(transformed.errors, `計測対象の変換に失敗しました: ${path}`);
  }
  const instrumenter = createInstrumenter({
    esModules: true,
    produceSourceMap: true,
    coverageGlobalScope: 'globalThis',
    coverageGlobalScopeFunc: false,
  });
  // rolldownのSource Map v3はversionをnumber型で公開している。
  const inputMap = transformed.map as Parameters<typeof instrumenter.instrumentSync>[2];
  const code = instrumenter.instrumentSync(transformed.code, path, inputMap);
  return { code, coverage: instrumenter.lastFileCoverage()!, map: instrumenter.lastSourceMap()! };
}
