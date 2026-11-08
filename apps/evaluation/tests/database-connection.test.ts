import type { D1Database } from '@cloudflare/workers-types';
import { expect, test, vi } from 'vitest';
import { createDb } from 'void/db';
import { createPrimaryDb } from '@korekaite/database/connection';

vi.mock('void/db', () => ({ createDb: vi.fn() }));

test('primary接続の指定だけを上書きし、その他のプロパティとgetterを委譲する', () => {
  const session = {};
  const binding = {
    marker: 'binding',
    get label() {
      return this.marker;
    },
    withSession: vi.fn(() => session),
  };
  const database = {} as ReturnType<typeof createDb>;
  vi.mocked(createDb).mockImplementation((input) => {
    const forwarded = input as object as typeof binding;
    expect(forwarded.marker).toBe('binding');
    expect(forwarded.label).toBe('binding');
    expect(forwarded.withSession()).toBe(session);
    return database;
  });
  expect(createPrimaryDb(binding as object as D1Database)).toBe(database);
  expect(binding.withSession).toHaveBeenCalledExactlyOnceWith('first-primary');
});
