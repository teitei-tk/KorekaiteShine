import { expect, test } from 'vitest';
import { isScenarioLocation } from '../location.ts';

test.each([
  'features/voice/retry.feature:7',
  'features/面接/再試行 v2.feature:10',
  'features/voice_interview.feature:1',
])('階層・日本語・空白を含むfeature位置%sを選択できる', (location) => {
  expect(isScenarioLocation(location)).toBe(true);
});
test.each([
  '../voice.feature:1',
  'features/../voice.feature:1',
  'features/./voice.feature:1',
  'features//voice.feature:1',
  'features/*.feature:1',
  'features/voice.feature:0',
  'features/voice:bad.feature:1',
  String.raw`features/voice\retry.feature:1`,
])('不正な位置%sは拒否する', (location) => {
  expect(isScenarioLocation(location)).toBe(false);
});
