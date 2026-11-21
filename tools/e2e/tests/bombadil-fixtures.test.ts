import { jsonObject, readJsonObject } from './bombadil-test-json.ts';
import { requireValue } from '../bombadil/required.ts';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { validateInterviewEvaluation } from '@korekaite/api-contracts/http/evaluation-validators';
import { createFixtures, parseFixtures, fixtureSql } from '../bombadil/fixtures.ts';
test('再現用の2面接はID・時刻・発言・評価を復元でき、正式DBとAPI契約に適合する', () => {
  const seed = '00000000-0000-4000-8000-000000000001';
  const fixture = createFixtures(seed);
  expect(createFixtures(seed)).toEqual(fixture);
  expect(parseFixtures(JSON.stringify(fixture))).toEqual(fixture);
  expect(createFixtures('00000000-0000-4000-8000-000000000002')).not.toEqual(fixture);
  for (const text of ['null', '{}', '{"seed":"bad"}', JSON.stringify({ ...fixture, version: 9 })]) {
    expect(() => parseFixtures(text)).toThrow();
  }
  const tampered = structuredClone(fixture);
  requireValue(tampered.interviews[0]).theme = '書き換えたテーマ';
  expect(() => parseFixtures(JSON.stringify(tampered))).toThrow();
  const db = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../../../packages/database/db/migrations/', import.meta.url);
    const journal = readJsonObject(readFileSync(new URL('meta/_journal.json', directory), 'utf8'));
    if (!Array.isArray(journal.entries)) {
      throw new TypeError('migration一覧がありません。');
    }
    for (const entry of journal.entries) {
      const { tag } = jsonObject(entry);
      if (typeof tag !== 'string') {
        throw new TypeError('migration名が不正です。');
      }
      db.exec(readFileSync(new URL(`${tag}.sql`, directory), 'utf8'));
    }
    db.exec(fixtureSql(fixture));
    const rows = db
      .prepare(`SELECT i.interview_id AS id, i.theme_title AS theme,
      i.status, i.created_at AS createdAt, f.content AS statement, a.result_json AS result
      FROM interviews i JOIN transcript_fragments f USING (interview_id)
      JOIN evaluation_inputs e USING (interview_id)
      JOIN jobs j USING (job_id) JOIN job_attempts a USING (job_id)
      WHERE j.status = 'completed' AND a.attempt_number = j.attempt_count
      ORDER BY i.created_at`)
      .all();
    expect(rows).toHaveLength(2);
    expect(new Set(fixture.interviews.map((row) => row.theme)).size).toBe(2);
    expect(new Set(fixture.interviews.map((row) => row.statement)).size).toBe(2);
    expect(new Set(fixture.interviews.map((row) => row.summary)).size).toBe(2);
    for (const [index, row] of rows.entries()) {
      const expected = requireValue(fixture.interviews[index]);
      expect(row).toMatchObject({
        id: expected.id,
        theme: expected.theme,
        status: 'ended',
        createdAt: expected.createdAt,
        statement: expected.statement,
      });
      const result = readJsonObject(String(row.result));
      expect(validateInterviewEvaluation(result)).toBe(true);
      expect(result.summary).toBe(expected.summary);
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // 同じ環境への再投入で、削除済みの記録や探索中の状態を補充しない。
    expect(() => db.exec(fixtureSql(fixture))).toThrow(/UNIQUE/u);
  } finally {
    db.close();
  }
});
