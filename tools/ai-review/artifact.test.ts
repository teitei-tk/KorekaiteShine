import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBounded } from './artifact.ts';

it('通常ファイルでも容量上限を超えた成果物は読み込まない', () => {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-bound-'));
  try {
    const path = join(directory, 'result.json');
    writeFileSync(path, '12345');
    expect(() => readBounded(path, 4)).toThrow('成果物の容量が不正です');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('UTF-8のバイト数が容量上限と等しい成果物は読み込める', () => {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-bound-'));
  try {
    const path = join(directory, 'result.json');
    writeFileSync(path, 'あ');
    expect(readBounded(path, 3)).toBe('あ');
    expect(() => readBounded(path, 2)).toThrow('成果物の容量が不正です');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
