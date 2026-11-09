import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { claimArtifactDirectory } from '../src/artifacts.ts';
import { resolveRuntime } from '../src/resources.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

test('生成物の所有記録を書けない場合は元の書き込みエラーを返す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'korekaite-artifact-error-'));
  try {
    const error = Object.assign(new Error('書き込み権限がありません'), { code: 'EACCES' });
    vi.mocked(writeFile).mockRejectedValueOnce(error);
    const runtime = resolveRuntime({
      repositoryRoot: root,
      appEnv: 'test',
      runId: 'write-error',
      parallelIndex: 0,
    });
    await expect(claimArtifactDirectory(runtime)).rejects.toBe(error);
    expect(writeFile).toHaveBeenCalledOnce();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
