import { afterEach, expect, test, vi } from 'vitest';
import { loadSources } from '@cucumber/cucumber/api';
vi.mock('@cucumber/cucumber/api', () => ({
  loadConfiguration: vi.fn().mockResolvedValue({ runConfiguration: { sources: {} } }),
  loadSources: vi.fn(),
}));
afterEach(() => vi.resetModules());
test.each([
  [{ errors: ['parse error'], plan: [] }, '検出に失敗'],
  [{ errors: [], plan: [] }, '検出に失敗'],
  [
    {
      errors: [],
      plan: [
        { uri: 'a.feature', location: { line: 1 } },
        { uri: 'a.feature', location: { line: 1 } },
      ],
    },
    '重複',
  ],
])('不正な検出結果を成功したシナリオ一覧として出力しない %j', async (result, message) => {
  vi.mocked(loadSources).mockResolvedValue(result);
  await expect(import('../list.mjs')).rejects.toThrow(message);
});
