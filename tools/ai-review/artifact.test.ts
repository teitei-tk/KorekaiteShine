import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readArtifactText } from './artifact.ts';
it('成果物は旧6MB上限を超えても読み込み、ディレクトリは拒否する', () => {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-size-'));
  try {
    const path = join(directory, 'plan.json');
    const text = 'あ'.repeat(2_000_001);
    writeFileSync(path, text);
    expect(readArtifactText(path)).toBe(text);
    expect(() => readArtifactText(directory)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
