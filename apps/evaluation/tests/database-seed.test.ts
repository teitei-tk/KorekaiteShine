import { expect, test, vi } from 'vitest';
import seed from '../../../packages/database/db/seed';
import * as schema from '@korekaite/database';

test('seedは接続確認のローカルデータを指定テーブルへの挿入実行まで要求する', async () => {
  const run = vi.fn();
  const values = vi.fn(() => ({ run }));
  const insert = vi.fn(() => ({ values }));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- このテスト専用の部分モックは呼ばれるAPIのみ実装し、未使用のプラットフォームAPIは省略する。
  await seed({ dialect: 'sqlite', schema, db: { insert } } as object as Parameters<typeof seed>[0]);
  expect(insert).toHaveBeenCalledExactlyOnceWith(schema.connectionChecks);
  expect(values).toHaveBeenCalledExactlyOnceWith([{ writer: 'fixture', value: 'local-only' }]);
  expect(run).toHaveBeenCalledTimes(1);
});
