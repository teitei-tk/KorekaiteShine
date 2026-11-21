import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { summarizeRecording } from '../bombadil/recording.ts';

test('記録ファイルをUTF-8の行単位で集計し、壊れた末尾や読み取り不能を成功にしない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bombadil-recording-test-'));
  const path = join(directory, 'trace.jsonl');
  const reached = [
    'analyzed',
    'edited-after-confirmation',
    'blocked-unconfirmed',
    'delayed-analysis-isolated',
  ];
  const row = JSON.stringify({
    action: 'Reload',
    snapshots: [
      { name: 'coverage', value: { reached } },
      { name: 'observation', value: 'あ'.repeat(32_768) },
    ],
    violations: [],
  });
  const summarize = () => summarizeRecording({ target: 'preparation', exitCode: 0, path });
  try {
    // UTF-8の途中とJSONの途中がread streamのチャンク境界をまたぐ。
    await writeFile(path, `${row}\r\n`.repeat(16));
    expect(await summarize()).toMatchObject({ status: 'passed', actions: 16, reached });
    await writeFile(path, `${row}\n{`);
    expect(await summarize()).toMatchObject({ status: 'infrastructure_error', actions: 1 });
    await writeFile(path, ' \n\r\n');
    expect(await summarize()).toMatchObject({ status: 'infrastructure_error', actions: 0 });
    await rm(path);
    await expect(summarize()).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
