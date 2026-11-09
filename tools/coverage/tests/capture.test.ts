import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createCounterJournal } from '../src/journal.ts';
import { startCapture, readCaptures } from '../src/capture.ts';
import { createMergeFixture } from './fixtures/measurement.ts';

test('開始時の未完了記録を、正常終了時のカウンター付き記録へ置き換える', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-capture-'));
  try {
    const { run, records, path } = createMergeFixture();
    const capture = startCapture(run, 'unit', directory, 'process-1');
    expect(JSON.parse(readFileSync(capture.path, 'utf8'))).toMatchObject({
      captureId: 'process-1',
      status: 'incomplete',
      files: [],
    });
    capture.finish({ [path]: records[0].files[0].coverage }, 'complete');
    const result = JSON.parse(readFileSync(capture.path, 'utf8'));
    expect(result).toEqual({ ...records[0], captureId: 'process-1' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('未知のファイルを黙って捨てず未完了の記録を残す', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-capture-'));
  try {
    const { run, records } = createMergeFixture();
    const capture = startCapture(run, 'unit', directory, 'process-2');
    expect(() => capture.finish({ unknown: records[0].files[0].coverage }, 'complete')).toThrow(
      '台帳にない計測対象: unknown',
    );
    expect(JSON.parse(readFileSync(capture.path, 'utf8')).status).toBe('incomplete');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('収集片のファイル自体が消えた場合も開始台帳から欠落を検出する', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-capture-'));
  try {
    const { run } = createMergeFixture();
    const capture = startCapture(run, 'unit', directory, 'missing');
    capture.finish({}, 'complete');
    expect(readCaptures(directory)).toHaveLength(1);
    rmSync(capture.path);
    expect(() => readCaptures(directory)).toThrow('収集片が欠落しています: missing');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('実行中のプロセスのjournalを完了扱いしない', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-capture-'));
  try {
    const { run } = createMergeFixture();
    const capture = startCapture(run, 'unit', directory, 'running');
    createCounterJournal(`${capture.path}.events`, run.targets);
    expect(readCaptures(directory)[0].status).toBe('incomplete');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('収集失敗の理由を計測片に残す', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-capture-'));
  try {
    const { run } = createMergeFixture();
    const capture = startCapture(run, 'unit', directory, 'failed');
    capture.finish({}, 'failed', 'Inspectorに接続できません');
    expect(readCaptures(directory)[0]).toMatchObject({
      status: 'failed',
      failure: 'Inspectorに接続できません',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
