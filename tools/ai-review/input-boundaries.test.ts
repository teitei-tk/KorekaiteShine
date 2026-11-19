import { normalizeSnapshot } from './snapshot.ts';
import { expect, it } from 'vitest';
import { validateMetadata } from './artifact.ts';
import { parseIsolationObservation } from './isolation-probe.ts';
import { requireValue } from './required.ts';
import { artifactFixture } from './tests/helpers/artifact.ts';
it.each([
  null,
  {},
  { ...artifactFixture().metadata, number: 0 },
  { ...artifactFixture().metadata, lines: null },
])('不正なメタデータを拒否する: %s', (value) =>
  expect(() => validateMetadata(value)).toThrow('成果物の対象が不正'),
);
it.each([
  null,
  {},
  { checks: [{ name: 'uid', passed: true, observation: 3 }] },
  { checks: [], passed: 'true' },
  { checks: [], pidNamespace: 1 },
  { checks: [], stage: 2 },
])('不正な隔離観測を拒否する: %s', (value) =>
  expect(() => parseIsolationObservation(JSON.stringify(value))).toThrow(
    'missing or failed isolation checks',
  ),
);
it.each([null, undefined])('必須値の欠落を拒否する: %s', (value) =>
  expect(() => requireValue(value)).toThrow(),
);

it('インライン履歴の非オブジェクトを拒否する', () => {
  expect(() => normalizeSnapshot({ issues: [], inline: [null], threads: [] })).toThrow(
    '履歴コメントが不正',
  );
});
