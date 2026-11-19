import { inventory } from '../src/inventory.ts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectTestFiles } from '../../local-integration/src/test-suites.ts';

const mocks = vi.hoisted(() => ({
  locations: vi.fn(() => JSON.stringify(['features/example.feature:1'])),
  specs: vi.fn<(root: string) => string[]>(() => ['tests/unit.test.ts']),
  close: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: mocks.locations }));
vi.mock('vitest/node', () => ({
  createVitest: ({ root }: { root: string }) =>
    Promise.resolve({
      globTestSpecifications: () =>
        Promise.resolve(mocks.specs(root).map((file) => ({ moduleId: path.join(root, file) }))),
      close: mocks.close,
    }),
}));
const state = { root: '' };
beforeEach(async () => {
  state.root = await mkdtemp(path.join(tmpdir(), 'ci-inventory-'));
  await Promise.all(
    ['apps', 'packages', 'tools'].map((parent) => mkdir(path.join(state.root, parent))),
  );
  mocks.locations.mockReturnValue(JSON.stringify(['features/example.feature:1']));
  mocks.specs.mockReturnValue(['tests/unit.test.ts']);
  mocks.close.mockClear();
});
afterEach(async () => {
  await rm(state.root, { recursive: true, force: true });
});
async function project(name: string, body: string) {
  await mkdir(path.join(state.root, name), { recursive: true });
  await writeFile(path.join(state.root, name, 'package.json'), body);
}
test('Node、Worker、通常と実時間の接続検査を分類して並べる', async () => {
  await writeFile(path.join(state.root, 'apps', 'README.md'), '');
  await mkdir(path.join(state.root, 'apps', 'empty'));
  await project('packages/no-script', '{}');
  await project('packages/no-test', '{"scripts":{}}');
  await project('apps/web', '{"scripts":{"test":"vitest run"}}');
  await project('tools/unit', '{"scripts":{"test":"vitest run"}}');
  await project('tools/native', '{"scripts":{"test":"node --test tests/*.test.ts"}}');
  await mkdir(path.join(state.root, 'tools/native/tests'));
  await writeFile(path.join(state.root, 'tools/native/tests/native.test.ts'), '');
  await project('tools/local-integration', '{"scripts":{"test":"vitest run"}}');
  mocks.specs.mockImplementation((directory) =>
    directory.endsWith('local-integration')
      ? [
          ...selectTestFiles('boundary'),
          ...selectTestFiles('integration-pr'),
          ...selectTestFiles('realtime'),
        ]
      : ['tests/unit.test.ts'],
  );
  const tests = await inventory(state.root);
  expect(new Set(tests.map((item) => item.runnerClass))).toEqual(
    new Set(['node', 'worker', 'boundary', 'integration', 'e2e']),
  );
  expect(tests.map((item) => item.id)).toEqual(tests.map((item) => item.id).toSorted());
  expect(
    tests.some((item) =>
      selectTestFiles('realtime').includes(item.file.replace('tools/local-integration/', '')),
    ),
  ).toBe(false);
  expect(tests.find((item) => item.project === 'tools/native')?.suite).toBe('node-test');
  expect(mocks.close).toHaveBeenCalledTimes(3);
});
test.each([
  ['[]', 'package.jsonが不正'],
  ['{"scripts":[]}', 'scriptsが不正'],
  ['{"scripts":{"test":1}}', 'test scriptが不正'],
  ['{"scripts":{"test":"node --test --watch"}}', 'Node test指定を解析できません'],
  ['{"scripts":{"test":"node --test absent.test.ts"}}', 'Node test検出が0件'],
  ['{', 'JSON'],
])('不正なmanifestを拒否する: %s', async (body, message) => {
  await project('tools/broken', body);
  await expect(inventory(state.root)).rejects.toThrow(message);
});
test('manifestの読込失敗を欠損扱いしない', async () => {
  await mkdir(path.join(state.root, 'tools/broken/package.json'), { recursive: true });
  await expect(inventory(state.root)).rejects.toThrow();
});
test('検出が空でもVitestを閉じる', async () => {
  await project('tools/empty', '{"scripts":{"test":"vitest run"}}');
  mocks.specs.mockReturnValue([]);
  await expect(inventory(state.root)).rejects.toThrow('テスト検出が0件');
  expect(mocks.close).toHaveBeenCalledOnce();
});
test.each([
  '{}',
  '[]',
  '[1]',
  '["../escape.feature:1"]',
  '["features/a.feature:1","features/a.feature:1"]',
])('不正なE2E一覧を拒否する: %s', async (body) => {
  mocks.locations.mockReturnValue(body);
  await expect(inventory(state.root)).rejects.toThrow();
});
