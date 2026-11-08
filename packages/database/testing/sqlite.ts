import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { createPrimaryDb } from '../src/connection.ts';

/** D1の通信境界だけを代替し、正式migrationとDrizzleのSQLをSQLiteで実行する。 */
export function createTestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../db/migrations/', import.meta.url);
  const journal: { entries: { tag: string }[] } = JSON.parse(
    readFileSync(new URL('meta/_journal.json', directory), 'utf8'),
  );
  for (const entry of journal.entries) {
    sqlite.exec(readFileSync(new URL(`${entry.tag}.sql`, directory), 'utf8'));
  }
  class Statement implements D1PreparedStatement {
    constructor(
      private query: string,
      private values: SQLInputValue[] = [],
    ) {}
    bind(...parameters: SQLInputValue[]): Statement {
      return new Statement(this.query, parameters);
    }
    execute<T>(): D1Result<T> {
      const results = sqlite.prepare(this.query).all(...this.values);
      const count = sqlite.prepare('SELECT changes() AS count, last_insert_rowid() AS id').get()!;
      return {
        success: true,
        results: results as T[],
        meta: {
          changes: Number(count.count),
          last_row_id: Number(count.id),
          changed_db: Number(count.count) > 0,
          duration: 0,
          size_after: 0,
          rows_read: results.length,
          rows_written: Number(count.count),
        },
      };
    }
    async all<T>(): Promise<D1Result<T>> {
      return this.execute<T>();
    }
    async run<T>(): Promise<D1Result<T>> {
      return this.execute<T>();
    }
    async first<T>(column?: string): Promise<T | null> {
      const row = sqlite.prepare(this.query).get(...this.values);
      return (row ? (column === undefined ? row : row[column]) : null) as T | null;
    }
    raw<T>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
    raw<T>(options?: { columnNames?: false }): Promise<T[]>;
    async raw<T>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
      const statement = sqlite.prepare(this.query);
      statement.setReturnArrays(true);
      const rows = statement.all(...this.values) as T[];
      return options?.columnNames
        ? [statement.columns().map((column) => column.name), ...rows]
        : rows;
    }
  }
  const session = {
    prepare: (query: string) => new Statement(query),
    batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => {
          if (!(statement instanceof Statement)) {
            throw new Error('別のDBのstatementは利用できません。');
          }
          return statement.execute<T>();
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    getBookmark: () => {
      throw new Error('bookmarkは実D1の結合検査で確認します。');
    },
  };
  const binding: D1Database = {
    ...session,
    withSession: () => session,
    exec: async () => {
      throw new Error('テストのSQL準備にはsqliteを使ってください。');
    },
    dump: async () => {
      throw new Error('dumpは代替しません。');
    },
  };
  return { sqlite, binding, db: createPrimaryDb(binding), close: () => sqlite.close() };
}
