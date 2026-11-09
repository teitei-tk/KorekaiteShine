import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';

// D1との実接続は結合検査で行う。ここでは正式migrationを独立したSQLiteへ適用する。
function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../../../packages/database/db/migrations/', import.meta.url);
  const journal: { entries: { tag: string }[] } = JSON.parse(
    readFileSync(new URL('meta/_journal.json', directory), 'utf8'),
  );
  for (const entry of journal.entries) {
    db.exec(readFileSync(new URL(`${entry.tag}.sql`, directory), 'utf8'));
  }
  return db;
}

test('本人ごとの進行中面接を一件に制限し、終了保存後に次を作成できる', () => {
  const db = openDatabase();
  try {
    const insert = db.prepare(`INSERT INTO interviews
      (interview_id, actor_id, material_hash, theme_title, theme_heading, theme_excerpt,
       background, status, created_at, updated_at)
      VALUES (?, ?, 'hash', '構成の判断', '背景', '架空の経験', '', 'ready', 0, 0)`);
    insert.run('first', 'actor');
    expect(() => insert.run('second', 'actor')).toThrow(/UNIQUE constraint/);
    insert.run('other', 'other-actor');
    db.prepare("UPDATE interviews SET status = 'ending' WHERE interview_id = 'first'").run();
    expect(() => insert.run('second', 'actor')).toThrow(/UNIQUE constraint/);
    db.prepare(
      "UPDATE interviews SET status = 'ended', ended_at = 1 WHERE interview_id = 'first'",
    ).run();
    insert.run('second', 'actor');
    expect(db.prepare('SELECT count(*) AS count FROM interviews').get()).toEqual({ count: 3 });
  } finally {
    db.close();
  }
});

test('終了時の固定入力と初回評価は一件だけを保持し、手動再評価を別ジョブとして保存する', () => {
  const db = openDatabase();
  try {
    db.exec(`INSERT INTO interviews
      (interview_id, actor_id, material_hash, theme_title, theme_heading, theme_excerpt,
       background, status, created_at, updated_at)
      VALUES ('interview', 'actor', 'hash', '構成', '背景', '架空の経験', '', 'ending', 0, 0);
      INSERT INTO jobs (job_id, actor_id, purpose, status, accepted_at, updated_at)
      VALUES ('first', 'actor', 'evaluation', 'pending', 0, 0),
        ('retry', 'actor', 'evaluation', 'pending', 0, 0);`);
    const insert = db.prepare(`INSERT INTO evaluation_inputs
      (job_id, interview_id, kind, last_sequence, input_json, model, prompt_version, rubric_version, created_at)
      VALUES (?, 'interview', ?, 0, '{}', 'test-model', 'v1', 'v1', 0)`);
    insert.run('first', 'initial');
    expect(() => insert.run('retry', 'initial')).toThrow(/UNIQUE constraint/);
    insert.run('retry', 'manual');
    expect(db.prepare('SELECT count(*) AS count FROM evaluation_inputs').get()).toEqual({
      count: 2,
    });
    // ジョブだけが消えて入力が残る状態を拒否する。削除処理でまとめて消す。
    expect(() => db.exec("DELETE FROM jobs WHERE job_id = 'first'")).toThrow(
      /FOREIGN KEY constraint/,
    );
  } finally {
    db.close();
  }
});

test('発言の受信IDと面接内の順序は重複できず、再生確認は原文と別に保存する', () => {
  const db = openDatabase();
  try {
    db.exec(`INSERT INTO interviews
      (interview_id, actor_id, material_hash, theme_title, theme_heading, theme_excerpt,
       background, status, created_at, updated_at)
      VALUES ('interview', 'actor', 'hash', '構成', '背景', '架空の経験', '', 'active', 0, 0)`);
    const insert = db.prepare(`INSERT INTO transcript_fragments
      (fragment_id, interview_id, sequence, generation, source_event_id, speaker, content, received_at)
      VALUES (?, 'interview', ?, ?, ?, 'assistant', '質問です', 0)`);
    insert.run('fragment-1', 1, 1, 'event-1');
    expect(() => insert.run('duplicate-event', 2, 1, 'event-1')).toThrow(/UNIQUE constraint/);
    expect(() => insert.run('duplicate-sequence', 1, 1, 'event-2')).toThrow(/UNIQUE constraint/);
    // 新しい上流接続では同じevent IDを再利用できる。
    insert.run('fragment-2', 2, 2, 'event-1');
    db.exec(`INSERT INTO playback_receipts
      (interview_id, generation, audio_offset_ms, received_at) VALUES ('interview', 1, 2400, 3000)`);
    expect(db.prepare('SELECT content FROM transcript_fragments ORDER BY sequence').all()).toEqual([
      { content: '質問です' },
      { content: '質問です' },
    ]);
    expect(() =>
      db.exec(`INSERT INTO playback_receipts
      (interview_id, generation, audio_offset_ms, received_at) VALUES ('missing', 1, 0, 0)`),
    ).toThrow(/FOREIGN KEY constraint/);
  } finally {
    db.close();
  }
});
