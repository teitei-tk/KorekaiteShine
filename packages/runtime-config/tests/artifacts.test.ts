import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { resolveRuntime } from '../src/resources.ts';
import { claimArtifactDirectory } from '../src/artifacts.ts';

test('別の環境の生成物が残るディレクトリは上書きせず拒否する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'korekaite-artifacts-'));
  try {
    const dev = resolveRuntime({ repositoryRoot: root, appEnv: 'development' });
    const other = resolveRuntime({
      repositoryRoot: root,
      appEnv: 'test',
      runId: 'run-a',
      parallelIndex: 0,
    });
    await claimArtifactDirectory(dev);
    await expect(
      claimArtifactDirectory({ ...other, artifactDirectory: dev.artifactDirectory }),
    ).rejects.toThrow('別環境');
    await expect(claimArtifactDirectory(dev)).resolves.toBe(dev.artifactDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
