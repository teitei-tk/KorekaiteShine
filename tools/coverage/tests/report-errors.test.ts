import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoverageMap } from '@vitest/istanbul-lib-coverage';
import { createSourceMapStore } from '@vitest/istanbul-lib-source-maps';
import { expect, onTestFinished, test, vi } from 'vitest';
import { instrumentSource } from '../src/instrument.ts';
import { writeReports } from '../src/report.ts';
vi.mock('@vitest/istanbul-lib-source-maps', { spy: true });

test('ソースマップ変換が実行可能なファイルを失った場合は報告を失敗させる', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-report-error-'));
  onTestFinished(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  const store = createSourceMapStore();
  vi.spyOn(store, 'transformCoverage').mockResolvedValue(createCoverageMap({}));
  vi.mocked(createSourceMapStore).mockReturnValue(store);
  const { coverage } = instrumentSource('value.ts', 'export const value = 1;');
  await expect(
    writeReports(createCoverageMap({ 'value.ts': coverage }), root, root),
  ).rejects.toThrow('元ソースへの変換でファイルが失われました');
  store.dispose();
});
