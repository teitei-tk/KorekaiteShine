import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { checkNodeSettings } from './check-node.ts';

async function inspect(contents: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'korekaite-node-settings-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const files = { '.node-version': '26.12.1\n', ...contents };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return checkNodeSettings(root, Object.keys(files));
}

test('ルートと子パッケージの範囲・型定義・CIの参照が一致すれば成功する', async () => {
  expect(
    await inspect({
      'package.json': JSON.stringify({ engines: { node: '>=26.12.1 <27' } }),
      'apps/worker/package.json': JSON.stringify({ devDependencies: { '@types/node': '^26.6.5' } }),
      '.github/workflows/docs.yml':
        'jobs:\n  docs:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .node-version\n',
    }),
  ).toEqual([]);
});

test('Nodeの更新後に残った古いengineと型定義をそれぞれ検出する', async () => {
  const errors = await inspect({
    'package.json': JSON.stringify({ engines: { node: '>=22 <23' } }),
    'tools/docs/package.json': JSON.stringify({ devDependencies: { '@types/node': '^22.20.5' } }),
  });
  expect(errors).toHaveLength(2);
  expect(errors[0]).toContain('engines.node');
  expect(errors[1]).toContain('@types/node');
});

test.each([
  'node-version: 26',
  'node-version-file: other-version',
  'node-version-file: .node-version\n          node-version: 26',
])('CIのバージョン直書き・参照間違いを検出する: %s', async (setting) => {
  const errors = await inspect({
    '.github/workflows/docs.yaml': `jobs:\n  docs:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          ${setting}\n`,
  });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('node-version-file');
});

test('曖昧なNode指定と不正なバージョン範囲を拒否する', async () => {
  expect(await inspect({ '.node-version': 'latest' })).toHaveLength(1);
  expect(await inspect({ 'package.json': '{"engines":{"node":"invalid"}}' })).toHaveLength(1);
});
