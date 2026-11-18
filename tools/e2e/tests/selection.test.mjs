import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfiguration, loadSources } from '@cucumber/cucumber/api';
import { expect, test } from 'vitest';

const cwd = fileURLToPath(new URL('../', import.meta.url));
test('PRシナリオを重複なく列挙し各行がExamplesを含め1件だけ選択する', async () => {
  const locations = JSON.parse(
    execFileSync(process.execPath, ['list.mjs'], { cwd, encoding: 'utf8' }),
  );
  const { runConfiguration } = await loadConfiguration(
    {
      file: false,
      provided: {
        paths: ['features/**/*.feature'],
        tags: '@pr',
      },
    },
    { cwd },
  );
  const all = await loadSources(runConfiguration.sources, { cwd });
  expect(all.errors).toEqual([]);
  expect(locations).toHaveLength(all.plan.length);
  expect(new Set(locations).size).toBe(locations.length);
  expect(locations.length).toBeGreaterThan(0);
  for (const location of locations) {
    const selected = await loadSources({ ...runConfiguration.sources, paths: [location] }, { cwd });
    expect(selected.errors).toEqual([]);
    expect(selected.plan).toHaveLength(1);
    const [pickle] = selected.plan;
    expect(`${pickle.uri}:${pickle.location.line}`).toBe(location);
  }
});
